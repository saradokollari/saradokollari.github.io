const fs = require('fs');
const http = require('http');
const https = require('https');
const querystring = require('querystring');
const url = require('url');

// 1. Load Credentials
const credentials = require('./auth/api_keys.json');
const lastfm_key = credentials.lastfm_key;
const giphy_key = credentials.giphy_key;

const port = 3000;
const server = http.createServer();

server.on("request", connection_handler);
server.listen(port, () => {
    console.log(`Server listening on port ${port}`);
});

function connection_handler(req, res) {
    console.log(`New Request for ${req.url} from ${req.socket.remoteAddress}`);

    if (req.url === "/") {
        const main = fs.createReadStream('html/main.html');
        res.writeHead(200, { "Content-Type": "text/html" });
        main.pipe(res);
    }

    else if (req.url.startsWith("/search")) {
        const url_parts = new url.URL(req.url, `http://localhost:${port}`);
        const artist = url_parts.searchParams.get("artist");
        const track = url_parts.searchParams.get("track");

        // VALIDATION: Artist is MANDATORY.
        // Since we removed 'required' from HTML, we catch it here.
        if (!artist) {
            res.writeHead(404, { "Content-Type": "text/plain" });
            res.end("404 Error: You must provide an Artist Name.");
            return;
        }

        // CACHE FILENAME
        const safe_track = track ? track : "only"; 
        const safe_filename = `${artist}-${safe_track}`.replace(/[^a-z0-9]/gi, '-').toLowerCase();
        const cache_path = `./cache/${safe_filename}.json`;

        if (fs.existsSync(cache_path)) {
            console.log("Cache Hit! Serving from file...");
            const cached_data = require(cache_path);
            step3_render(cached_data, res);
        } else {
            console.log("Cache Miss. Calling APIs...");
            step1_lastfm(artist, track, res, safe_filename);
        }
    }

    else {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("404 Not Found");
    }
}

function stream_to_message(stream, callback, ...args) {
    let body = "";
    stream.on("data", chunk => body += chunk);
    stream.on("end", () => callback(body, ...args));
}

// ==========================================
// STEP 1: LAST.FM (With Listener Check & Dynamic Limits)
// ==========================================
function step1_lastfm(artist, track, res, filename) {
    console.log("API 1 Called: Last.fm");
    
    let method = "artist.getInfo";
    let params = `&artist=${querystring.escape(artist)}`;
    
    if (track) {
        method = "track.getInfo";
        params += `&track=${querystring.escape(track)}`;
    }

    const lastfm_url = `https://ws.audioscrobbler.com/2.0/?method=${method}&api_key=${lastfm_key}${params}&format=json`;

    https.get(lastfm_url, (api_res) => {
        stream_to_message(api_res, (body) => {
            const data = JSON.parse(body);

            // 1. ERROR CHECK
            if (data.error) {
                res.writeHead(404, { "Content-Type": "text/plain" });
                res.end(`404 Error: ${data.message}`);
                return;
            }

            let returned_name = "";
            let listener_count = 0;
            
            // 2. PARSE DATA & LISTENERS
            if (data.track) {
                returned_name = data.track.artist.name;
                // Track listeners are directly on the object
                listener_count = parseInt(data.track.listeners);
            } 
            else if (data.artist) {
                returned_name = data.artist.name;
                // Artist listeners are inside 'stats'
                if (data.artist.stats && data.artist.stats.listeners) {
                    listener_count = parseInt(data.artist.stats.listeners);
                }
            }

            // 3. STRICT NAME MATCHING
            if (returned_name.toLowerCase() !== artist.toLowerCase()) {
                res.writeHead(404, { "Content-Type": "text/plain" });
                res.end(`404 Error: Artist name mismatch. You searched '${artist}', but Last.fm returned '${returned_name}'.`);
                return;
            }

            // 4. THE POPULARITY FILTER (New Feature)
            // If the artist/track has fewer than 100k listeners, we consider it "too obscure"
            if (listener_count < 100000) {
                res.writeHead(404, { "Content-Type": "text/plain" });
                res.end(`404 Error: '${returned_name}' was found, but has only ${listener_count} listeners. This app requires >100k listeners to ensure high-quality GIF results.`);
                return;
            }

            // 5. PREPARE DISPLAY DATA
            let tags = [];
            let date_info = "";
            let title = returned_name;
            let subtitle = "Artist Profile";

            if (data.track) {
                title = data.track.name;
                subtitle = `Song by ${returned_name}`;
                if (data.track.wiki && data.track.wiki.published) {
                    date_info = `Released: ${data.track.wiki.published}`;
                }
                if (data.track.toptags && data.track.toptags.tag) {
                    tags = data.track.toptags.tag.map(t => t.name);
                }
            } else {
                if (data.artist.tags && data.artist.tags.tag) {
                    tags = data.artist.tags.tag.map(t => t.name);
                }
            }

            let tag_string = tags.join(", ");
            if (date_info) tag_string = `${date_info} | Tags: ${tag_string}`;
            
            // 6. DYNAMIC RANDOMNESS & SEARCH QUERY
            let search_query = "";
            let randomness_limit = 50; // Default: High variety for Artists

            if (track) {
                // Song Mode: High Relevance Required
                search_query = `${returned_name} ${track}`;
                randomness_limit = 15; // Lower limit to keep GIFs relevant to the video
            } else {
                // Artist Mode: High Variety Allowed
                search_query = `${returned_name}`;
                randomness_limit = 50; // Higher limit to explore different eras/interviews
            }

            const music_data = {
                title: title,
                subtitle: subtitle,
                tags: tag_string,
                search_q: search_query,
                random_limit: randomness_limit // Pass this to Step 2
            };

            step2_giphy(music_data, res, filename);
        });
    });
}

// ==========================================
// STEP 2: GIPHY (Uses Dynamic Random Limit)
// ==========================================
function step2_giphy(music_data, res, filename) {
    console.log("API 2 Called: Giphy");

    // DYNAMIC RANDOMIZATION:
    // We use the limit calculated in Step 1 (15 for songs, 50 for artists)
    const random_offset = Math.floor(Math.random() * music_data.random_limit);

    const giphy_url = `https://api.giphy.com/v1/gifs/search?api_key=${giphy_key}&q=${querystring.escape(music_data.search_q)}&limit=6&offset=${random_offset}`;

    https.get(giphy_url, (api_res) => {
        stream_to_message(api_res, (body) => {
            const data = JSON.parse(body);
            
            let images = [];
            if (data.data && data.data.length > 0) {
                images = data.data.map(gif => gif.images.original.url);
            }

            music_data.images = images;

            // Cache & Render
            const cache_path = `./cache/${filename}.json`;
            fs.writeFile(cache_path, JSON.stringify(music_data), (err) => {
                step3_render(music_data, res);
            });
        });
    });
}

// ==========================================
// STEP 3: RENDER (Using Template File)
// ==========================================
function step3_render(data, res) {
    // Read the separate HTML file
    fs.readFile('html/results.html', 'utf8', (err, template) => {
        if (err) {
            res.writeHead(500);
            res.end("Error loading template");
            return;
        }

        // Create 6 <img> tags
        let image_html = "";
        if (data.images.length > 0) {
            image_html = data.images.map(url => 
                `<img src="${url}" style="width: 100%; border: 1px solid #ccc;">`
            ).join("");
        } else {
            image_html = "<p>No GIFs found.</p>";
        }

        // Replace Placeholders
        let final_html = template
            .replace('{{title}}', data.title)
            .replace('{{title}}', data.title) // Replace twice (Head + H1)
            .replace('{{subtitle}}', data.subtitle)
            .replace('{{tags}}', data.tags)
            .replace('{{images}}', image_html);

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(final_html);
    });
}