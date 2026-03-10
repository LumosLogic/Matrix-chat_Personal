const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();
const PORT = 9001;

console.log('🚀 Starting Matrix Server Proxy...');

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'OK', matrix_proxy: 'running' });
});

// Admin panel assets - MUST be before Matrix catch-all
app.use('/assets', createProxyMiddleware({
  target: 'http://localhost:8080',
  changeOrigin: true
}));

app.use('/manifest.json', createProxyMiddleware({
  target: 'http://localhost:8080',
  changeOrigin: true
}));

app.use('/favicon.ico', createProxyMiddleware({
  target: 'http://localhost:8080',
  changeOrigin: true
}));

// Admin panel
app.use('/admin', createProxyMiddleware({
  target: 'http://localhost:8080',
  changeOrigin: true
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

// Matrix Synapse - ALL routes EXCEPT admin assets
app.use('/', (req, res, next) => {
  // Skip Matrix proxy for admin assets and admin routes
  if (req.path.startsWith('/assets/') || 
      req.path === '/manifest.json' || 
      req.path === '/favicon.ico' ||
      req.path.startsWith('/admin')) {
    return next('route');
  }
  next();
}, createProxyMiddleware({
  target: 'http://localhost:8008',
  changeOrigin: true,
  ws: true
}));

app.listen(PORT, () => {
  console.log(`✅ Matrix Server running perfectly`);
  console.log(`🔗 URL: https://franco-saucier-lucie.ngrok-free.dev`);
  console.log(`📋 Ready for Matrix clients!`);
});