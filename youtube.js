const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

// Temporary SPIDER-API YouTube diagnostics
const { execFile } = require("child_process");

function diagnostic(command, args) {
    return new Promise(resolve => {
        execFile(command, args, { timeout: 10000 }, (error, stdout, stderr) => {
            resolve({
                available: !error,
                output: (stdout || stderr || error?.message || "").trim().slice(0, 500)
            });
        });
    });
}

module.exports = function youtubeVideo(req, res) {
    const input = String(req.query.url || "").trim();

    if (!input) {
        return res.status(400).json({
            status: false,
            error: "Provide a YouTube video URL."
        });
    }

    let parsed;

    try {
        parsed = new URL(input);
    } catch {
        return res.status(400).json({
            status: false,
            error: "Invalid video URL."
        });
    }

    const allowedHosts = [
        "youtube.com",
        "www.youtube.com",
        "m.youtube.com",
        "youtu.be",
        "www.youtu.be"
    ];

    if (!allowedHosts.includes(parsed.hostname.toLowerCase())) {
        return res.status(400).json({
            status: false,
            error: "Only YouTube video URLs are supported."
        });
    }

    if (
        parsed.searchParams.has("list") ||
        parsed.pathname.includes("/playlist")
    ) {
        return res.status(400).json({
            status: false,
            error: "YouTube playlists are not supported."
        });
    }

    const videoId = parsed.hostname.includes("youtu.be")
        ? parsed.pathname.split("/").filter(Boolean)[0]
        : parsed.searchParams.get("v") ||
          parsed.pathname.match(
              /\/(?:shorts|embed|live)\/([a-zA-Z0-9_-]{11})/
          )?.[1];

    if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
        return res.status(400).json({
            status: false,
            error: "Invalid YouTube video ID."
        });
    }

    const videoUrl =
        `https://www.youtube.com/watch?v=${videoId}`;

    const outputDir = path.join(__dirname, "outputs");

    fs.mkdirSync(outputDir, { recursive: true });

    const id = crypto.randomUUID();
    const outputPath = path.join(outputDir, `${id}.mp4`);
    const outputTemplate = path.join(outputDir, `${id}.%(ext)s`);

    const cleanup = () => {
        try {
            for (const file of fs.readdirSync(outputDir)) {
                if (file.startsWith(id)) {
                    fs.rmSync(path.join(outputDir, file), {
                        force: true
                    });
                }
            }
        } catch (error) {
            console.error("[SPIDER-API] Cleanup error:", error.message);
        }
    };

    const args = [
        "--js-runtimes", "node",
        "--no-playlist",
        "--no-warnings",
        "--no-progress",
        "--max-filesize", "100M",
        "-f", "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b",
        "--merge-output-format", "mp4",
        "-o", outputTemplate,
        videoUrl
    ];

    let stderr = "";
    let finished = false;

    const finishError = (status, message) => {
        if (finished || res.headersSent) return;

        finished = true;
        clearTimeout(timer);
        cleanup();

        return res.status(status).json({
            status: false,
            error: message
        });
    };

    Promise.all([
        diagnostic("yt-dlp", ["--version"]),
        diagnostic("node", ["--version"])
    ]).then(([yt, node]) => {
        console.log("[SPIDER-API] Runtime diagnostics:", {
            ytDlp: yt,
            node
        });
    });

    const child = spawn("yt-dlp", args);

    child.stderr.on("data", data => {
        stderr += data.toString();

        if (stderr.length > 12000) {
            stderr = stderr.slice(-12000);
        }
    });

    const timer = setTimeout(() => {
        child.kill("SIGTERM");

        finishError(
            504,
            "YouTube download timed out. Please try again later."
        );
    }, 180000);

    child.on("error", error => {
        finishError(
            500,
            `Unable to start yt-dlp: ${error.message}`
        );
    });

    child.on("close", code => {
        if (finished) return;

        if (code !== 0) {
            console.error("[SPIDER-API] YouTube yt-dlp error:", stderr.slice(-5000));
            const blocked =
                /sign in to confirm|not a bot|authentication|login required/i
                    .test(stderr);

            if (blocked) {
                return finishError(
                    403,
                    "YouTube restricted this request with bot verification. SPIDER-API is working, but YouTube did not authorize this download."
                );
            }

            return finishError(
                502,
                stderr.trim().slice(-1500) ||
                `yt-dlp exited with code ${code}.`
            );
        }

        if (!fs.existsSync(outputPath)) {
            return finishError(
                500,
                "yt-dlp finished but no MP4 output was created."
            );
        }

        const stats = fs.statSync(outputPath);

        if (!stats.size) {
            return finishError(
                500,
                "The downloaded video file is empty."
            );
        }

        if (stats.size > 100 * 1024 * 1024) {
            return finishError(
                413,
                "The video exceeds the 100 MB API limit."
            );
        }

        finished = true;
        clearTimeout(timer);

        res.download(
            outputPath,
            "SPIDER-MD-VIDEO.mp4",
            error => {
                cleanup();

                if (error) {
                    console.error(
                        "[SPIDER-API] Send error:",
                        error.message
                    );
                }
            }
        );
    });
};
