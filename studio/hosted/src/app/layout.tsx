import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "gooey-studio",
  description: "Replicad part scripts, a live preview and path-traced renders",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
