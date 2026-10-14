import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 全部 API 走 Authorization 头鉴权、页面为客户端应用，无静态缓存诉求；
  // 关闭 cacheComponents 以保留各路由的 dynamic 导出控制
  cacheComponents: false,
  // 用 127.0.0.1 打开时，Next 默认把 /_next/* 开发资源当作跨源请求拦掉，
  // 结果是页面只渲染 SSR 首帧、完全不水合（验证码不加载、点击无响应）。
  allowedDevOrigins: ['127.0.0.1'],
  // svg-captcha 运行时按 __dirname 读包内字体文件，Turbopack 打包会破坏该路径，
  // 外置为运行时从 node_modules 加载
  serverExternalPackages: ['svg-captcha'],
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
