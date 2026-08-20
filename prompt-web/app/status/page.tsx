import type { Metadata } from "next";
import { StatusDashboard } from "@/components/status-dashboard";

export const metadata: Metadata = {
  title: "任务状态与复核",
  description: "查看抓取任务进度并处理待复核项目。",
};

export default function StatusPage() {
  return <StatusDashboard />;
}
