import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "QNCH Control Centre",
  description: "QNCH business intelligence and financial control centre",
  // Authentication decides who may read this; indexing decides who learns it exists. A
  // competitor who finds the login page learns the brand runs one of these and where. The
  // meta tag covers pages a crawler reaches by link rather than by robots.txt.
  robots: { index: false, follow: false, nocache: true },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en-GB">
      <body>{children}</body>
    </html>
  );
}
