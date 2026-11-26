import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// https://vite.dev/config/
export default defineConfig({
  server: {
    host: '0.0.0.0',
    // 前端 /api 请求代理到后端 Express（默认 3000）
    // SSE 流式对话必须正确透传，不能被代理缓冲
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        // http-proxy 默认会缓冲响应体，导致 SSE 卡住
        // 手动接管响应：直接 pipe 给前端，保证流不被截断
        selfHandleResponse: true,
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes, _req, res) => {
            // 把后端响应头原样拷给前端，特别是 Content-Type: text/event-stream
            Object.keys(proxyRes.headers).forEach((key) => {
              res.setHeader(key, proxyRes.headers[key])
            })
            // SSE 防缓冲
            if (proxyRes.headers['content-type']?.includes('event-stream')) {
              res.setHeader('Cache-Control', 'no-cache')
              res.setHeader('X-Accel-Buffering', 'no')
            }
            proxyRes.pipe(res)
          })
        },
      },
      // 上传的图片由后端 /uploads 静态托管，开发期同样需要代理
      '/uploads': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  plugins: [vue()],
})
