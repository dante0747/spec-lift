import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SpecLift — Private Swagger 2 to OpenAPI 3 Converter",
  description:
    "Convert Swagger 2 JSON to OpenAPI 3.0.3 entirely in your browser. No uploads, accounts, telemetry, or external services.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
