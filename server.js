import express from "express";
import { spawn } from "child_process";
import path from "path";
import fs from "fs";

const app = express();
const PORT = 3000;

// Track SSE subscribers per job so multiple downloads can run at once.
const clients = new Map(); // jobId -> Set<res>
const ensureDir = dir => {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    console.error("Failed to ensure directory", dir, err);
    throw err;
  }
};
const DEFAULT_SAVE_DIR = process.cwd();

app.use(express.json());
app.use(express.static("public"));

app.get("/progress", (req, res) => {
  const { jobId } = req.query;
  if (!jobId) {
    return res.status(400).end("jobId required");
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  if (res.flushHeaders) res.flushHeaders();

  if (!clients.has(jobId)) {
    clients.set(jobId, new Set());
  }
  clients.get(jobId).add(res);

  req.on("close", () => {
    const set = clients.get(jobId);
    if (set) {
      set.delete(res);
      if (!set.size) {
        clients.delete(jobId);
      }
    }
  });
});

function sendProgress(jobId, value) {
  const set = clients.get(jobId);
  if (!set) return;
  const payload = JSON.stringify({ jobId, progress: value });
  set.forEach(res => {
    res.write(`data: ${payload}\n\n`);
  });
}

app.post("/download", (req, res) => {
  const { url, jobId, downloadDir, filename, streamToClient } = req.body || {};

  if (!url) {
    return res.status(400).json({ error: "No URL provided" });
  }

  const jobKey = typeof jobId === "string" && jobId.trim() ? jobId.trim() : `job-${Date.now()}`;
  const safeId = jobKey.replace(/[^a-zA-Z0-9_-]/g, "");
  const safeName = typeof filename === "string" ? filename.trim() : "";
  const sanitizedName = safeName ? safeName.replace(/[/\\?%*:|"<>]/g, "") : "";
  const finalName = sanitizedName
    ? (sanitizedName.toLowerCase().endsWith(".mp4") ? sanitizedName : `${sanitizedName}.mp4`)
    : `video_${safeId || Date.now()}.mp4`;
  const targetDir = downloadDir ? path.resolve(downloadDir) : DEFAULT_SAVE_DIR;

  try {
    ensureDir(targetDir);
  } catch (err) {
    return res.status(500).json({ error: "Could not access download directory." });
  }

  const outputPath = path.join(targetDir, finalName);

  const ytdlp = spawn("yt-dlp", [
    "-f", "best",
    "--newline",
    "--progress-template", "%(progress._percent_str)s",
    "-o", outputPath,
    "--merge-output-format", "mp4",
    url
  ]);

  ytdlp.stdout.on("data", data => {
    const text = data.toString().trim();
    const match = text.match(/(\d+(\.\d+)?)%/);
    if (match) {
      sendProgress(jobKey, Number(match[1]));
    }
  });

  ytdlp.on("close", code => {
    if (code !== 0 || !fs.existsSync(outputPath)) {
      sendProgress(jobKey, 0);
      return res.status(500).json({ error: "Download failed" });
    }

    sendProgress(jobKey, 100);

    if (streamToClient) {
      return res.download(outputPath, finalName, () => {
        fs.unlink(outputPath, () => {});
      });
    }

    return res.json({
      ok: true,
      fileName: finalName,
      savedPath: outputPath
    });
  });
});

app.listen(PORT, () => {
  console.log(`READY → http://localhost:${PORT}`);
});
