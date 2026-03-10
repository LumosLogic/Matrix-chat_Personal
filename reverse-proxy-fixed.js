const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();
const PORT = 9001;

console.log('🚀 Starting Reverse Proxy Server...');

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'OK', proxy: 'running' });
});

// Admin panel - NO path rewrite, direct proxy
app.use('/admin', createProxyMiddleware({
  target: 'http://localhost:8080',
  changeOrigin: true,
  pathRewrite: (path, req) => {
    // Remove /admin prefix but keep the rest
    return path.replace('/admin', '') || '/';
  }
}));

// API routes
app.use('/api', createProxyMiddleware({
  target: 'http://localhost:3000',
  changeOrigin: true
}));

app.use('/location', createProxyMiddleware({
  target: 'http://localhost:3000',
  changeOrigin: true
}));

app.use('/.well-known', createProxyMiddleware({
  target: 'http://localhost:3000',
  changeOrigin: true
}));

// Matrix Synapse - everything else
app.use('/', createProxyMiddleware({
  target: 'http://localhost:8008',
  changeOrigin: true,
  ws: true
}));

app.listen(PORT, () => {
  console.log(`✅ Reverse proxy running on port ${PORT}`);
  console.log(`📋 Matrix + Admin + API all working`);
});