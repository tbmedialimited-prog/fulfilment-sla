import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SLA Dashboard - Fulfilment Experts",
  description: "Warehouse dispatch & DPD delivery SLA tracking",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
