const express = require('express');
const cors = require('cors');
const axios = require('axios');
const useragent = require('useragent');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const DATA_FILE = 'visitors.json';
const LINKS_FILE = 'links.json';

// Initialize storage files
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, '[]');
if (!fs.existsSync(LINKS_FILE)) fs.writeFileSync(LINKS_FILE, '{}');

// Get client IP (handles proxies)
function getClientIP(req) {
    return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 
           req.headers['x-real-ip'] || 
           req.connection.remoteAddress || 
           req.socket.remoteAddress ||
           (req.connection.socket ? req.connection.socket.remoteAddress : null);
}

// Fetch GPS coordinates from IP using external API
async function getIPGeolocation(ip) {
    try {
        // Remove IPv6 prefix if present
        const cleanIP = ip.replace(/^::ffff:/, '');
        
        // Skip private IPs (localhost, internal networks)
        if (cleanIP === '127.0.0.1' || cleanIP === '::1' || cleanIP.startsWith('192.168.') || cleanIP.startsWith('10.')) {
            return { 
                status: 'private', 
                note: 'Local/private IP - no geolocation available',
                ip: cleanIP
            };
        }

        // Using ip-api.com (free, no key, 45 req/min limit)
        const response = await axios.get(`http://ip-api.com/json/${cleanIP}?fields=status,message,continent,continentCode,country,countryCode,region,regionName,city,district,zip,lat,lon,timezone,currency,isp,org,as,asname,reverse,mobile,proxy,hosting,query`, {
            timeout: 5000
        });

        if (response.data.status === 'success') {
            return {
                status: 'success',
                ip: response.data.query,
                coordinates: {
                    latitude: response.data.lat,
                    longitude: response.data.lon
                },
                location: {
                    city: response.data.city,
                    region: response.data.regionName,
                    country: response.data.country,
                    countryCode: response.data.countryCode,
                    zip: response.data.zip,
                    district: response.data.district
                },
                timezone: response.data.timezone,
                isp: {
                    name: response.data.isp,
                    organization: response.data.org,
                    as: response.data.as,
                    asname: response.data.asname
                },
                connection: {
                    mobile: response.data.mobile,
                    proxy: response.data.proxy,
                    hosting: response.data.hosting
                },
                reverseDNS: response.data.reverse
            };
        } else {
            throw new Error(response.data.message);
        }
    } catch (error) {
        console.error('Geolocation API error:', error.message);
        return { 
            status: 'error', 
            error: error.message,
            ip: ip 
        };
    }
}

// Main tracking endpoint
app.get('/track/:id', async (req, res) => {
    const startTime = Date.now();
    const trackId = req.params.id;
    
    try {
        const clientIP = getClientIP(req);
        const ua = useragent.parse(req.headers['user-agent']);
        
        // Get geolocation data from external API
        const geoData = await getIPGeolocation(clientIP);
        
        // Collect all visitor data
        const visitorData = {
            id: uuidv4(),
            trackId: trackId,
            timestamp: new Date().toISOString(),
            ip: {
                address: clientIP,
                version: clientIP.includes(':') ? 'IPv6' : 'IPv4'
            },
            geolocation: geoData,
            device: {
                browser: {
                    family: ua.family,
                    version: ua.toVersion(),
                    major: ua.major,
                    minor: ua.minor,
                    patch: ua.patch
                },
                os: {
                    family: ua.os.family,
                    version: ua.os.toVersion(),
                    major: ua.os.major
                },
                device: {
                    family: ua.device.family,
                    model: ua.device.model,
                    vendor: ua.device.vendor,
                    type: ua.device.type || 'desktop'
                }
            },
            network: {
                userAgent: req.headers['user-agent'],
                acceptLanguage: req.headers['accept-language'],
                acceptEncoding: req.headers['accept-encoding'],
                accept: req.headers['accept'],
                connection: req.headers.connection,
                dnt: req.headers.dnt,
                upgradeInsecureRequests: req.headers['upgrade-insecure-requests'],
                secFetchDest: req.headers['sec-fetch-dest'],
                secFetchMode: req.headers['sec-fetch-mode'],
                secFetchSite: req.headers['sec-fetch-site'],
                secFetchUser: req.headers['sec-fetch-user'],
                secChUa: req.headers['sec-ch-ua'],
                secChUaMobile: req.headers['sec-ch-ua-mobile'],
                secChUaPlatform: req.headers['sec-ch-ua-platform'],
                referrer: req.headers.referer || 'Direct',
                origin: req.headers.origin
            },
            server: {
                protocol: req.protocol,
                secure: req.secure,
                httpVersion: req.httpVersion,
                method: req.method
            },
            timing: {
                responseTime: Date.now() - startTime
            }
        };

        // Save to database
        const logs = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        logs.push(visitorData);
        fs.writeFileSync(DATA_FILE, JSON.stringify(logs, null, 2));

        console.log(`[+] Tracked: ${clientIP} | ${geoData.status === 'success' ? `${geoData.location.city}, ${geoData.location.country}` : 'Unknown'} | ${ua.family}`);

        // Return 1x1 transparent GIF (tracking pixel)
        const pixel = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
        res.setHeader('Content-Type', 'image/gif');
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.send(pixel);

    } catch (error) {
        console.error('Tracking error:', error);
        res.status(500).send();
    }
});

// Create short link
app.post('/api/create-link', express.json(), (req, res) => {
    const { targetUrl, alias } = req.body;
    const id = alias || Math.random().toString(36).substring(2, 8);
    
    const links = JSON.parse(fs.readFileSync(LINKS_FILE, 'utf8'));
    links[id] = {
        target: targetUrl,
        created: new Date().toISOString(),
        clicks: 0
    };
    fs.writeFileSync(LINKS_FILE, JSON.stringify(links, null, 2));
    
    res.json({ 
        shortUrl: `${req.protocol}://${req.get('host')}/r/${id}`,
        id: id,
        adminUrl: `${req.protocol}://${req.get('host')}/admin.html`
    });
});

// Redirect endpoint
app.get('/r/:id', (req, res) => {
    const links = JSON.parse(fs.readFileSync(LINKS_FILE, 'utf8'));
    const link = links[req.params.id];
    
    if (link) {
        link.clicks++;
        link.lastAccess = new Date().toISOString();
        fs.writeFileSync(LINKS_FILE, JSON.stringify(links, null, 2));
        
        // Serve redirect page that tracks then redirects
        res.sendFile(path.join(__dirname, 'public', 'redirect.html'));
    } else {
        res.status(404).send('Link not found');
    }
});

// Get target URL for redirect page
app.get('/api/target/:id', (req, res) => {
    const links = JSON.parse(fs.readFileSync(LINKS_FILE, 'utf8'));
    const link = links[req.params.id];
    res.json({ target: link?.target || 'https://google.com' });
});

// Admin API - get all logs
app.get('/api/logs', (req, res) => {
    try {
        const logs = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        res.json(logs.reverse());
    } catch (e) {
        res.json([]);
    }
});

// Admin API - get statistics
app.get('/api/stats', (req, res) => {
    try {
        const logs = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        const links = JSON.parse(fs.readFileSync(LINKS_FILE, 'utf8'));
        
        const stats = {
            totalVisits: logs.length,
            uniqueIPs: new Set(logs.map(l => l.ip.address)).size,
            countries: {},
            browsers: {},
            os: {},
            devices: {},
            recentActivity: logs.slice(-10).reverse()
        };
        
        logs.forEach(log => {
            if (log.geolocation?.location?.country) {
                stats.countries[log.geolocation.location.country] = 
                    (stats.countries[log.geolocation.location.country] || 0) + 1;
            }
            if (log.device?.browser?.family) {
                stats.browsers[log.device.browser.family] = 
                    (stats.browsers[log.device.browser.family] || 0) + 1;
            }
            if (log.device?.os?.family) {
                stats.os[log.device.os.family] = 
                    (stats.os[log.device.os.family] || 0) + 1;
            }
        });
        
        res.json(stats);
    } catch (e) {
        res.json({ error: e.message });
    }
});

// Clear logs (admin only - add auth in production)
app.delete('/api/logs', (req, res) => {
    fs.writeFileSync(DATA_FILE, '[]');
    res.json({ message: 'Logs cleared' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════════════════════╗
║           IP Logger Server Running                       ║
╠════════════════════════════════════════════════════════╣
║  Public URL: http://localhost:${PORT}                    ║
║  Admin Panel: http://localhost:${PORT}/admin.html      ║
║  Create Link: POST /api/create-link                      ║
╚════════════════════════════════════════════════════════╝
    `);
});