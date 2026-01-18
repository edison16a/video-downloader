import express from "express";
import { spawn } from "child_process";
import path from "path";
import fs from "fs";

const app = express();
const PORT = 3000;

let clients = [];

app.use(express.json());
app.use(express.static("public"));

app.get("/progress", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  clients.push(res);

  req.on("close", () => {
    clients = clients.filter(c => c !== res);
  });
});

function sendProgress(value) {
  clients.forEach(res => {
    res.write(`data: ${value}\n\n`);
  });
}

app.post("/download", (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: "No URL provided" });
  }

  const outputFile = `video_${Date.now()}.mp4`;
  const outputPath = path.join(process.cwd(), outputFile);

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
      sendProgress(match[1]);
    }
  });

  ytdlp.on("close", code => {
    sendProgress("100");

    if (code !== 0 || !fs.existsSync(outputPath)) {
      return res.status(500).json({ error: "Download failed" });
    }

    res.download(outputPath, () => {
      fs.unlinkSync(outputPath);
    });
  });
});

app.listen(PORT, () => {
  console.log(`READY → http://localhost:${PORT}`);
});
