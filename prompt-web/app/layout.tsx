import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Crawl Prompt Studio",
    template: "%s · Crawl Prompt Studio",
  },
  description: "生成商品抓取任务 Prompt，并查看自动化抓取流水线状态。",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
