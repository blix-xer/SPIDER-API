
const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const youtubeVideo = require("./youtube");

const app = express();

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY;
const MAX_FILE_SIZE = 50 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 8192;

const uploadDir = path.join(__dirname, "uploads");
const outputDir = path.join(__dirname, "outputs");

for (const dir of [uploadDir, outputDir]) {
    fs.mkdirSync(dir, { recursive: true });
}

if (!API_KEY) {
    console.error("[SPIDER-API] API_KEY is missing.");
    process.exit(1);
}

const allowedTypes = [
    "video/mp4",
    "video/webm",
    "video/quicktime",
    "video/x-matroska",
    "audio/mpeg",
    "audio/mp4",
    "audio/wav",
    "audio/x-wav",
    "audio/ogg",
    "audio/webm",
    "audio/flac",
    "image/jpeg",
    "image/png",
    "image/webp"
];

// Upload configuration
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        cb(null, crypto.randomUUID() + ext);
    }
});

const upload = multer({
    storage,
    limits: {
        fileSize: MAX_FILE_SIZE,
        files: 1
    },
    fileFilter: (req, file, cb) => {
        if (!allowedTypes.includes(file.mimetype)) {
            return cb(new Error("Unsupported media file type."));
        }

        cb(null, true);
    }
});

// API key protection
function authenticate(req, res, next) {
    const key = req.headers["x-api-key"];

    if (!key || key !== API_KEY) {
        return res.status(401).json({
            status: false,
            error: "Invalid or missing API key."
        });
    }

    next();
}

// Remove temporary files
async function removeFile(filePath) {
    if (!filePath) return;

    try {
        await fs.promises.unlink(filePath);
    } catch (error) {
        if (error.code !== "ENOENT") {
            console.error("[SPIDER-API] Cleanup error:", error.message);
        }
    }
}

// Run FFmpeg or FFprobe without a shell
function runProcess(command, args) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args);
        let stdout = "";
        let stderr = "";

        child.stdout.on("data", data => {
            stdout += data.toString();
        });

        child.stderr.on("data", data => {
            stderr += data.toString();
        });

        child.on("error", reject);

        child.on("close", code => {
            if (code === 0) {
                resolve({ stdout, stderr });
            } else {
                reject(
                    new Error(
                        stderr.slice(-3000) || `${command} failed.`
                    )
                );
            }
        });
    });
}

// Read media information
async function getMediaInfo(filePath) {
    const result = await runProcess("ffprobe", [
        "-v", "error",
        "-show_format",
        "-show_streams",
        "-of", "json",
        filePath
    ]);

    const data = JSON.parse(result.stdout);
    const format = data.format || {};

    return {
        filename: format.filename || path.basename(filePath),
        format: format.format_name || "unknown",
        duration: Number(format.duration || 0),
        size: Number(format.size || 0),
        bitrate: Number(format.bit_rate || 0),
        streams: (data.streams || []).map(stream => ({
            type: stream.codec_type,
            codec: stream.codec_name,
            width: stream.width || null,
            height: stream.height || null,
            sampleRate: stream.sample_rate || null,
            channels: stream.channels || null
        }))
    };
}

// Confirm uploaded file is an image
async function getImageInfo(filePath) {
    const info = await getMediaInfo(filePath);
    const imageStream = info.streams.find(
        stream => stream.type === "video"
    );

    if (!imageStream) {
        throw new Error("The uploaded file is not a supported image.");
    }

    return {
        format: info.format,
        width: imageStream.width,
        height: imageStream.height,
        size: info.size,
        codec: imageStream.codec
    };
}

// Validate requested output format
function getImageFormat(value) {
    const format = String(value || "").toLowerCase();

    if (format === "jpeg") return "jpg";

    if (!["jpg", "png", "webp"].includes(format)) {
        throw new Error("Supported image formats: jpg, png and webp.");
    }

    return format;
}

// Build FFmpeg image output arguments
function imageOutputArgs(format, outputPath) {
    if (format === "jpg") {
        return ["-frames:v", "1", "-q:v", "2", "-y", outputPath];
    }

    if (format === "png") {
        return [
            "-frames:v", "1",
            "-compression_level", "6",
            "-y", outputPath
        ];
    }

    return [
        "-frames:v", "1",
        "-c:v", "libwebp",
        "-quality", "90",
        "-y", outputPath
    ];
}

// Public information
app.get("/", (req, res) => {
    res.json({
        name: "SPIDER-API",
        version: "1.5.0",
        status: "online",
        engine: "FFmpeg"
    });
});

// Health check
app.get("/api/health", (req, res) => {
    res.json({
        status: true,
        message: "SPIDER-API Media, Image and Video Engine is running.",
        version: "1.5.0"
    });
});

// Read information from an uploaded media file
app.post(
    "/api/media/info",
    authenticate,
    upload.single("media"),
    async (req, res) => {
        if (!req.file) {
            return res.status(400).json({
                status: false,
                error: "Upload a file using the media field."
            });
        }

        try {
            const info = await getMediaInfo(req.file.path);

            res.json({
                status: true,
                message: "Media information retrieved.",
                data: info
            });
        } catch (error) {
            res.status(400).json({
                status: false,
                error: "Unable to read this media file."
            });
        } finally {
            await removeFile(req.file.path);
        }
    }
);

// Convert uploaded media to MP3 or MP4
app.post(
    "/api/media/convert",
    authenticate,
    upload.single("media"),
    async (req, res) => {
        if (!req.file) {
            return res.status(400).json({
                status: false,
                error: "Upload a file using the media field."
            });
        }

        const inputPath = req.file.path;
        const format = String(req.query.format || "").toLowerCase();

        if (!["mp3", "mp4"].includes(format)) {
            await removeFile(inputPath);

            return res.status(400).json({
                status: false,
                error: "Supported formats: mp3 and mp4."
            });
        }

        const outputPath = path.join(
            outputDir,
            crypto.randomUUID() + "." + format
        );

        try {
            const info = await getMediaInfo(inputPath);
            const hasVideo = info.streams.some(s => s.type === "video");
            const hasAudio = info.streams.some(s => s.type === "audio");

            if (!hasAudio && format === "mp3") {
                throw new Error("The uploaded file has no audio stream.");
            }

            if (!hasVideo && format === "mp4") {
                throw new Error("MP4 conversion requires a video stream.");
            }

            let args;

            if (format === "mp3") {
                args = [
                    "-i", inputPath,
                    "-vn",
                    "-codec:a", "libmp3lame",
                    "-q:a", "2",
                    "-y", outputPath
                ];
            } else {
                args = [
                    "-i", inputPath,
                    "-c:v", "libx264",
                    "-preset", "veryfast",
                    "-crf", "23",
                    "-c:a", "aac",
                    "-b:a", "128k",
                    "-movflags", "+faststart",
                    "-y", outputPath
                ];
            }

            await runProcess("ffmpeg", args);

            res.download(
                outputPath,
                `SPIDER-MD.${format}`,
                async error => {
                    await removeFile(inputPath);
                    await removeFile(outputPath);

                    if (error) {
                        console.error(
                            "[SPIDER-API] Download error:",
                            error.message
                        );
                    }
                }
            );

        } catch (error) {
            await removeFile(inputPath);
            await removeFile(outputPath);

            console.error(
                "[SPIDER-API] Conversion error:",
                error.message
            );

            if (!res.headersSent) {
                res.status(400).json({
                    status: false,
                    error: error.message || "Media conversion failed."
                });
            }
        }
    }
);

// Upload and inspect a media file
app.post(
    "/api/media/upload",
    authenticate,
    upload.single("media"),
    async (req, res) => {
        if (!req.file) {
            return res.status(400).json({
                status: false,
                error: "No media file uploaded."
            });
        }

        try {
            const info = await getMediaInfo(req.file.path);

            res.json({
                status: true,
                message: "Media uploaded successfully.",
                file: {
                    name: req.file.filename,
                    originalName: req.file.originalname,
                    size: req.file.size
                },
                mediaInfo: info
            });
        } catch (error) {
            await removeFile(req.file.path);

            res.status(400).json({
                status: false,
                error: "Unable to inspect the uploaded file."
            });
        }
    }
);

// Get image information
app.post(
    "/api/image/info",
    authenticate,
    upload.single("media"),
    async (req, res) => {
        if (!req.file) {
            return res.status(400).json({
                status: false,
                error: "Upload an image using the media field."
            });
        }

        try {
            if (!req.file.mimetype.startsWith("image/")) {
                throw new Error("Please upload a JPG, PNG or WebP image.");
            }

            const info = await getImageInfo(req.file.path);

            res.json({
                status: true,
                message: "Image information retrieved.",
                data: info
            });
        } catch (error) {
            res.status(400).json({
                status: false,
                error: error.message
            });
        } finally {
            await removeFile(req.file.path);
        }
    }
);

// Convert image format
app.post(
    "/api/image/convert",
    authenticate,
    upload.single("media"),
    async (req, res) => {
        if (!req.file) {
            return res.status(400).json({
                status: false,
                error: "Upload an image using the media field."
            });
        }

        const inputPath = req.file.path;
        let outputPath;

        try {
            if (!req.file.mimetype.startsWith("image/")) {
                throw new Error("Please upload a JPG, PNG or WebP image.");
            }

            const format = getImageFormat(req.query.format);
            await getImageInfo(inputPath);

            outputPath = path.join(
                outputDir,
                crypto.randomUUID() + "." + format
            );

            await runProcess("ffmpeg", [
                "-i", inputPath,
                ...imageOutputArgs(format, outputPath)
            ]);

            res.download(
                outputPath,
                `SPIDER-MD.${format}`,
                async error => {
                    await removeFile(inputPath);
                    await removeFile(outputPath);

                    if (error) {
                        console.error(
                            "[SPIDER-API] Image download error:",
                            error.message
                        );
                    }
                }
            );

        } catch (error) {
            await removeFile(inputPath);
            if (outputPath) await removeFile(outputPath);

            res.status(400).json({
                status: false,
                error: error.message || "Image conversion failed."
            });
        }
    }
);

// Resize image
app.post(
    "/api/image/resize",
    authenticate,
    upload.single("media"),
    async (req, res) => {
        if (!req.file) {
            return res.status(400).json({
                status: false,
                error: "Upload an image using the media field."
            });
        }

        const inputPath = req.file.path;
        let outputPath;

        try {
            if (!req.file.mimetype.startsWith("image/")) {
                throw new Error("Please upload a JPG, PNG or WebP image.");
            }

            const width = Number(req.query.width);
            const height = Number(req.query.height);

            if (
                !Number.isInteger(width) ||
                !Number.isInteger(height) ||
                width < 1 ||
                height < 1 ||
                width > MAX_IMAGE_DIMENSION ||
                height > MAX_IMAGE_DIMENSION
            ) {
                throw new Error(
                    `Width and height must be integers between 1 and ${MAX_IMAGE_DIMENSION}.`
                );
            }

            const format = getImageFormat(
                req.query.format || "jpg"
            );

            await getImageInfo(inputPath);

            outputPath = path.join(
                outputDir,
                crypto.randomUUID() + "." + format
            );

            const scaleFilter =
                `scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
                `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`;

            await runProcess("ffmpeg", [
                "-i", inputPath,
                "-vf", scaleFilter,
                ...imageOutputArgs(format, outputPath)
            ]);

            res.download(
                outputPath,
                `SPIDER-MD-${width}x${height}.${format}`,
                async error => {
                    await removeFile(inputPath);
                    await removeFile(outputPath);

                    if (error) {
                        console.error(
                            "[SPIDER-API] Resize download error:",
                            error.message
                        );
                    }
                }
            );

        } catch (error) {
            await removeFile(inputPath);
            if (outputPath) await removeFile(outputPath);

            res.status(400).json({
                status: false,
                error: error.message || "Image resizing failed."
            });
        }
    }
);

// SPIDER image enhancement
app.post(
    "/api/image/enhance",
    authenticate,
    upload.single("media"),
    async (req, res) => {
        if (!req.file) {
            return res.status(400).json({
                status: false,
                error: "Upload an image using the media field."
            });
        }

        const inputPath = req.file.path;
        let outputPath;

        try {
            if (!req.file.mimetype.startsWith("image/")) {
                throw new Error("Please upload a JPG, PNG or WebP image.");
            }

            const info = await getImageInfo(inputPath);
            const scale = Math.max(info.width, info.height) <= 4096 ? 2 : 1;

            outputPath = path.join(
                outputDir,
                crypto.randomUUID() + ".jpg"
            );

            const filter =
                "hqdn3d=1.5:1.5:3:3," +
                "unsharp=5:5:0.7:3:3:0.3," +
                "eq=contrast=1.05:brightness=0.01:saturation=1.04," +
                "scale=iw*" + scale + ":ih*" + scale + ":flags=lanczos";

            await runProcess("ffmpeg", [
                "-i", inputPath,
                "-vf", filter,
                "-frames:v", "1",
                "-q:v", "2",
                "-y", outputPath
            ]);

            res.download(
                outputPath,
                "SPIDER-ENHANCED.jpg",
                async error => {
                    await removeFile(inputPath);
                    await removeFile(outputPath);

                    if (error) {
                        console.error("[SPIDER-API] Enhancement download error:", error.message);
                    }
                }
            );

        } catch (error) {
            await removeFile(inputPath);
            if (outputPath) await removeFile(outputPath);

            if (!res.headersSent) {
                res.status(400).json({
                    status: false,
                    error: error.message || "Image enhancement failed."
                });
            }
        }
    }
);


 // SPIDER-MD MP3 converter
app.post("/api/media/mp3", authenticate, upload.single("media"), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ status: false, error: "No audio or video uploaded." });
    }

    const inputPath = req.file.path;
    const coverPath = path.join(__dirname, "assets", "spider-cover.jpg");
    const outputPath = path.join(outputDir, crypto.randomUUID() + ".mp3");

    try {
        if (!fs.existsSync(coverPath)) {
            throw new Error("SPIDER-MD cover image is missing.");
        }

        const info = await getMediaInfo(inputPath);
        if (!info.streams.some(stream => stream.type === "audio")) {
            throw new Error("This file does not contain an audio stream.");
        }

        await runProcess("ffmpeg", [
            "-i", inputPath,
            "-i", coverPath,
            "-map", "0:a:0",
            "-map", "1:v:0",
            "-c:a", "libmp3lame",
            "-b:a", "192k",
            "-c:v", "mjpeg",
            "-disposition:v", "attached_pic",
            "-id3v2_version", "3",
            "-metadata", "title=SPIDER-MD",
            "-metadata", "artist=BLIX-XER",
            "-metadata", "album=SPIDER-MD/BLIX-XER",
            "-metadata:s:v", "title=Album cover",
            "-metadata:s:v", "comment=Cover (front)",
            "-y", outputPath
        ]);

        res.download(outputPath, "SPIDER-MD-BLIX-XER.mp3", async error => {
            await removeFile(inputPath);
            await removeFile(outputPath);
            if (error) console.error("[SPIDER-API] MP3 send error:", error.message);
        });
    } catch (error) {
        await removeFile(inputPath);
        await removeFile(outputPath);
        if (!res.headersSent) {
            res.status(400).json({ status: false, error: error.message || "MP3 conversion failed." });
        }
    }
});

// YouTube video endpoint (authorized videos only)
app.get("/api/youtube/video", authenticate, youtubeVideo);

// Handle upload and server errors
app.use((err, req, res, next) => {
    console.error("[SPIDER-API] Error:", err.message);

    if (req.file && req.file.path) {
        removeFile(req.file.path);
    }

    if (!res.headersSent) {
        res.status(400).json({
            status: false,
            error: err.message || "Request failed."
        });
    }
});

app.listen(PORT, "0.0.0.0", () => {
    console.log("--------------------------------");
    console.log("       SPIDER-API ONLINE");
    console.log("--------------------------------");
    console.log("Version: 1.5.0");
    console.log("Engine: FFmpeg");
    console.log("Port:", PORT);
    console.log("Address: http://127.0.0.1:" + PORT);
});
