'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { CloseOutlined, DeleteOutlined, HistoryOutlined, LogoutOutlined, MessageOutlined, MenuFoldOutlined, MenuUnfoldOutlined, MoreOutlined, PlusCircleOutlined } from '@ant-design/icons';
import { App, Button, Dropdown } from 'antd';
import { ApiError, conversations, createConversation, deleteConversation, type Conversation } from '@/lib/api';
import LoadMore from '@/components/LoadMore';
import Logo from '@/components/Logo';
import { useAuth } from '@/store/auth';
import { useUI } from '@/store/ui';

// 侧边栏会话分页：每页 20 条，滚到底自动加载下一页（见 LoadMore）
const PAGE_SIZE = 20;
// 刷新（替换式重拉）时的最大窗口，与后端 MAX_PAGE_SIZE 对齐
const MAX_PAGE_SIZE = 100;

// 折叠态样式统一用 sidebar-collapsed: 变体（globals.css @custom-variant），由 <html data-sidebar> 决定
// （该属性由服务端根据 cookie 渲染，见 app/layout.tsx）：
// 服务端/客户端输出的 class 一致 → 无水合不一致；首帧前已写好属性 → 刷新不闪动。
export default function Shell({ children }: { children: React.ReactNode }) {
  const { modal } = App.useApp();
  const pathname = usePathname();
  const router = useRouter();
  const { token, user, hydrate, logout } = useAuth();
  const { sidebarOpen, setSidebarOpen, conversationsVersion } = useUI();
  const [items, setItems] = useState<Conversation[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  // 请求去重（state 异步，滚动可能连触发多次）
  const loadingRef = useRef(false);
  // 已加载条数：刷新时按它取同一窗口，避免把翻过的页丢掉
  const loadedRef = useRef(0);
  useEffect(() => { loadedRef.current = items.length; }, [items.length]);

  // 拉一页：offset=0 替换（首次/刷新），否则追加并按 id 去重（并发/新会话插入兜底）
  const fetchPage = async (offset: number, replace: boolean, limit = PAGE_SIZE) => {
    if (!token || loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      const page = await conversations(token, { limit, offset });
      setItems((old) => {
        if (replace) return page.items;
        const seen = new Set(old.map((item) => item.id));
        return [...old, ...page.items.filter((item) => !seen.has(item.id))];
      });
      setTotal(page.total);
    } catch (error) {
      // 只有后端明确返回 401 才算登录失效。快速刷新时浏览器会中断在途请求
      // （AbortError/Failed to fetch），这类错误不清登录态，否则会把好的 token 抹掉、
      // 下次加载因读不到 token 而误跳登录页；5xx/网络抖动同样只跳过本次拉取
      if (error instanceof ApiError && error.status === 401) {
        logout(); router.replace('/login');
      }
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  };
  useEffect(() => { hydrate(); }, [hydrate]);
  // 只在「登录态变化」与「列表版本号变化」时重拉：路由切换（点侧栏会话）不再重拉——
  // 否则已翻到第 2 页的列表会被截回第 1 页，列表缩短 + 滚动跳位，点一下会话就闪一下。
  // 懒创建、历史页改名/删除都会 bumpConversations()，列表照旧同步。
  useEffect(() => {
    if (token) {
      // 刷新按「已加载条数」取同一窗口：列表不会因一次刷新被截回第 1 页（缩表 + 滚动跳位就是闪动来源）
      void fetchPage(0, true, Math.min(MAX_PAGE_SIZE, Math.max(PAGE_SIZE, loadedRef.current)));
    } else if (token === null && localStorage.getItem('friday_token') === null) router.replace('/login');
  }, [token, conversationsVersion]);
  // 路由变化时收起移动端抽屉
  useEffect(() => { setSidebarOpen(false); }, [pathname, setSidebarOpen]);

  const toggleCollapsed = () => {
    const collapsed = document.documentElement.getAttribute('data-sidebar') === 'collapsed';
    const next = collapsed ? 'expanded' : 'collapsed';
    document.documentElement.setAttribute('data-sidebar', next);
    // 写 cookie（而非 localStorage），服务端下次渲染即可直接输出正确状态
    document.cookie = `friday_sidebar=${next}; path=/; max-age=31536000; SameSite=Lax`;
  };
  const add = async () => {
    if (!token) return;
    const item = await createConversation(token);
    setItems((old) => [item, ...old]);
    setTotal((count) => count + 1);
    router.push(`/chat/${item.id}`);
  };
  // 退出登录属于不可逆操作（要重新登录），先弹二次确认
  const confirmLogout = () => modal.confirm({
    title: '退出登录？',
    content: '退出后需要重新输入账号密码才能继续使用。',
    okText: '退出登录',
    cancelText: '再想想',
    okButtonProps: { danger: true },
    onOk: () => { logout(); router.replace('/login'); },
  });
  const remove = (id: string) => modal.confirm({
    title: '删除这个对话？',
    content: '对话和全部消息将被永久删除。',
    okButtonProps: { danger: true },
    onOk: async () => {
      if (!token) return;
      await deleteConversation(token, id);
      setItems((old) => old.filter((item) => item.id !== id));
      setTotal((count) => Math.max(count - 1, 0));
      if (pathname.includes(id)) router.push('/chat');
    },
  });

  const label = (text: string) => <span className="whitespace-nowrap sidebar-collapsed:md:hidden">{text}</span>;
  // 选中态：展开态用左侧 3px 竖条 + 浅蓝底；折叠态胶囊变窄，竖条会糊成月牙色块，故只留浅蓝底
  const navClass = (active: boolean) => `flex items-center gap-2 rounded-xl px-3 py-2 text-sm transition-colors sidebar-collapsed:md:justify-center sidebar-collapsed:md:px-0 ${active ? 'bg-brand-soft font-medium text-brand-text shadow-[inset_3px_0_0_#4d6bfe] sidebar-collapsed:md:shadow-none' : 'text-body hover:bg-hover'}`;
  const row = (item: Conversation) => (
    <div key={item.id} className={`group mb-1 flex items-center rounded-xl ${pathname.includes(item.id) ? 'bg-brand-soft' : 'hover:bg-hover'}`}>
      <Link href={`/chat/${item.id}`} className="flex min-w-0 flex-1 items-center gap-1.5 px-3 py-2 text-[13.5px] text-body">
        <span className="truncate" title={item.title}>{item.title}</span>
      </Link>
      <Dropdown menu={{ items: [{ key: 'delete', danger: true, icon: <DeleteOutlined />, label: '删除', onClick: () => remove(item.id) }] }}>
        <button className="mr-2 grid h-7 w-7 shrink-0 place-items-center rounded-lg text-muted opacity-0 group-hover:opacity-100">
          <MoreOutlined />
        </button>
      </Dropdown>
    </div>
  );

  return (
    <div className="flex h-screen overflow-hidden bg-canvas">
      {sidebarOpen && <div className="fixed inset-0 z-30 bg-overlay/30 backdrop-blur-[2px] md:hidden" onClick={() => setSidebarOpen(false)} />}

      {/* overflow-hidden：宽度过渡期间裁掉溢出内容，避免文字溢出到主区域 */}
      <aside className={`fixed inset-y-0 left-0 z-40 flex h-full w-[268px] shrink-0 flex-col overflow-hidden border-r border-line bg-gradient-to-b from-panel via-soft to-panel-to transition-[width,transform] duration-200 sidebar-collapsed:md:w-[72px] md:static md:translate-x-0 ${sidebarOpen ? 'translate-x-0 shadow-[0_0_60px_rgba(15,27,61,.25)]' : '-translate-x-full'}`}>

        {/* 头部：展开态是品牌名 + 折叠按钮；折叠态 logo 隐藏，只留居中的展开按钮（窄栏放不下两个 32px 控件） */}
        <div className="flex h-[60px] shrink-0 items-center px-4 sidebar-collapsed:md:h-14 sidebar-collapsed:md:justify-center sidebar-collapsed:md:px-0">
          <Logo className="h-8 w-8 shrink-0 drop-shadow-[0_6px_14px_rgba(77,107,254,.45)] sidebar-collapsed:md:hidden" />
          <b className="ml-2 min-w-0 flex-1 truncate whitespace-nowrap bg-gradient-to-r from-ink-soft to-[#4d6bfe] bg-clip-text text-[17px] text-transparent sidebar-collapsed:md:hidden">Friday Agent</b>
          <button title="收起菜单" onClick={() => setSidebarOpen(false)} className="ml-auto grid h-8 w-8 shrink-0 place-items-center rounded-lg text-muted hover:bg-hover md:hidden">
            <CloseOutlined />
          </button>
          <button title="展开/收起侧边栏" onClick={toggleCollapsed} className="ml-auto hidden h-8 w-8 shrink-0 place-items-center rounded-lg text-muted hover:bg-hover sidebar-collapsed:md:ml-0 md:grid">
            <span className="grid place-items-center sidebar-collapsed:md:hidden">
              <MenuFoldOutlined />
            </span>
            <span className="hidden place-items-center sidebar-collapsed:md:grid">
              <MenuUnfoldOutlined />
            </span>
          </button>
        </div>

        {/* 三个入口之间的间距：展开态 12px（+ → 对话）/ 8px（对话 → 历史记录）；折叠态统一 12px */}
        <div className="px-3 pb-3 sidebar-collapsed:md:px-2">
          <Button onClick={add} icon={<PlusCircleOutlined />} block title="开启新对话" className="h-10 text-left sidebar-collapsed:md:px-0">
            <span className="whitespace-nowrap sidebar-collapsed:md:hidden">开启新对话</span>
          </Button>
        </div>

        <nav className="space-y-2 px-3 pb-2 sidebar-collapsed:md:space-y-3 sidebar-collapsed:md:px-2">
          <Link href="/chat" className={navClass(pathname.startsWith('/chat'))}>
            <MessageOutlined />
            {label('对话')}
          </Link>
          <Link href="/history" className={navClass(pathname === '/history')}>
            <HistoryOutlined />
            {label('历史记录')}
            <span className="ml-auto whitespace-nowrap text-xs sidebar-collapsed:md:hidden">{total}</span>
          </Link>
        </nav>

        <div className="scroll-hide min-h-0 flex-1 overflow-y-auto px-3">
          <div className="sidebar-collapsed:md:hidden">
            <p className="px-3 pb-1 pt-2 text-xs text-muted-weak">对话</p>
            {items.map((item) => row(item))}
            <LoadMore
              compact
              hasMore={items.length < total}
              loading={loading}
              loaded={items.length}
              total={total}
              onLoad={() => { void fetchPage(items.length, false); }}
            />
            {total === 0 && <p className="px-3 py-2 text-xs text-muted-weak">暂无对话</p>}
          </div>
        </div>

        {/* 底部：展开态是头像 + 用户名 + 退出按钮；折叠态只留头像，退出登录收进头像菜单 */}
        <div className="border-t border-line p-3 sidebar-collapsed:md:p-2">
          <div className="flex items-center gap-2 rounded-xl px-2 py-2 sidebar-collapsed:md:justify-center sidebar-collapsed:md:px-0">
            <Dropdown
              trigger={['click']}
              placement="topRight"
              menu={{
                items: [
                  { key: 'user', label: user?.username, disabled: true },
                  { type: 'divider' },
                  { key: 'logout', icon: <LogoutOutlined />, label: '退出登录', onClick: confirmLogout },
                ],
              }}
            >
              <button type="button" title="账号" aria-label="账号菜单" className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[#4d6bfe] text-sm text-white transition hover:brightness-110">
                {user?.username.slice(0, 1).toUpperCase()}
              </button>
            </Dropdown>
            <span className="min-w-0 flex-1 truncate whitespace-nowrap text-sm sidebar-collapsed:md:hidden">{user?.username}</span>
            <button title="退出登录" onClick={confirmLogout} className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-muted hover:bg-hover sidebar-collapsed:md:hidden">
              <LogoutOutlined />
            </button>
          </div>
        </div>
      </aside>

      <main className="min-w-0 flex-1">{children}</main>
    </div>
  );
}
