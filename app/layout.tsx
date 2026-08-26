import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "QNCH Control Centre",
  description: "QNCH business intelligence and financial control centre",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en-GB">
      <body>{children}</body>
    </html>
  );
}
