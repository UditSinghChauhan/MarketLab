const fs = require("fs");
const http = require("http");
const path = require("path");

const buildDir = path.resolve(process.argv[2] || "dashboard/build");
const port = Number(process.argv[3] || 3001);

const types = {
  ".css": "text/css",
  ".html": "text/html",
  ".js": "text/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
};

const server = http.createServer((req, res) => {
  const requestPath = decodeURIComponent(req.url.split("?")[0]);
  const requestedFile = path.join(buildDir, requestPath);
  const safePath = requestedFile.startsWith(buildDir) ? requestedFile : buildDir;
  const filePath = fs.existsSync(safePath) && fs.statSync(safePath).isFile()
    ? safePath
    : path.join(buildDir, "index.html");
  const ext = path.extname(filePath);

  res.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream" });
  fs.createReadStream(filePath).pipe(res);
});

server.listen(port, () => {
  console.log(`Serving ${buildDir} on http://localhost:${port}`);
});
