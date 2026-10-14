import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { AntdRegistry } from '@ant-design/nextjs-registry';
import Providers from './providers';
// antd reset 已在 globals.css 里以 @import ... layer(antd-reset) 引入（必须位于层叠的低优先级层，
// 否则它会作为无层级样式压过 Tailwind 的 @layer utilities，详见 globals.css 顶部注释）
import 'katex/dist/katex.min.css';
import './globals.css';

export const metadata: Metadata = { title: 'Friday Agent', description: 'AI Agent 助手' };

// 主题与侧边栏折叠状态都存 cookie，由服务端直接渲染到 <html> 上：
// - 首帧即最终外观，不会出现「展开→收起」的闪动
// - 不需要在组件树里渲染 <script>（React 19 会报 "Encountered a script tag"）
export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const jar = await cookies();
  const theme = jar.get('friday_theme')?.value === 'dark' ? 'dark' : 'light';
  const sidebar = jar.get('friday_sidebar')?.value === 'collapsed' ? 'collapsed' : 'expanded';
  return (
    <html lang="zh-CN" data-theme={theme} data-sidebar={sidebar} suppressHydrationWarning>
      <body suppressHydrationWarning>
        {/* KaTeX 字体预热：会话消息里的公式在客户端拉取后才渲染（约几百 ms 后），
            若那时字体未加载，会先按回退字体排版、字体到达后整体重排一次（刷新偏移的
            残余来源之一）。这里用隐藏元素在文档解析期就把常用 KaTeX 字体拉下来，
            公式首绘即最终布局。 */}
        <span aria-hidden style={{ position: 'absolute', width: 0, height: 0, overflow: 'hidden', visibility: 'hidden' }}>
          <span style={{ fontFamily: 'KaTeX_Main' }}>x</span>
          <span style={{ fontFamily: 'KaTeX_Math' }}>x</span>
          <span style={{ fontFamily: 'KaTeX_Size1' }}>x</span>
          <span style={{ fontFamily: 'KaTeX_Size2' }}>x</span>
          <span style={{ fontFamily: 'KaTeX_Size4' }}>x</span>
        </span>
        {/* AntdRegistry 负责在 SSR 阶段把 antd 的 CSS-in-JS 样式抽成 <style id="antd-cssinjs">。
            它必须和 antd 共用同一份 @ant-design/cssinjs 实例，否则 StylesProvider 的 cache 收不到
            任何样式、抽取结果为空，首帧就是「无 antd 样式」的塌陷布局，水合后才补上 → 刷新抖动。
            npm 默认会给 registry 装 cssinjs v2（peer >=1.0.0）、给 antd 装 v1，两个实例的 React
            Context 不互通；因此 package.json 把 @ant-design/cssinjs 显式锁到 ^1.24.0 并加 overrides
            去重。升级 antd / registry / cssinjs 时务必复查 `npm ls @ant-design/cssinjs` 只剩一份。 */}
        <AntdRegistry>
          <Providers initialTheme={theme}>{children}</Providers>
        </AntdRegistry>
      </body>
    </html>
  );
}
