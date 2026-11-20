import type { Metadata } from "next";
import "../public/legacy/style.css";
import "./caregap.css";

export const metadata: Metadata = {
  title: "CareGap · 우리 동네 복지와 제공기관",
  description: "전국 지역별 복지사업을 비교하고, 공식 근거가 있는 제공기관과 신청 창구를 확인하세요.",
  icons: {
    icon: "/legacy/mark.svg",
    shortcut: "/legacy/mark.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
