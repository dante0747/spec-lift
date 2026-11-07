import type { Metadata, Viewport } from "next";
import "@fontsource-variable/bricolage-grotesque";
import "@fontsource-variable/geist";
import "@fontsource-variable/jetbrains-mono";
import "./globals.css";

const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
const siteUrl =
  process.env.NEXT_PUBLIC_SITE_URL?.trim() ||
  "https://speclift-private-converter.majid0747.chatgpt.site";
const siteOrigin = new URL(siteUrl).origin;
const previewImage = new URL(`${basePath}/og.png`, siteOrigin).toString();
const title = "SpecLift — Private Swagger 2 to OpenAPI 3 Converter";
const description =
  "Convert Swagger 2.0 JSON or YAML to OpenAPI 3 entirely in your browser, with the same output as Swagger's official converter. No uploads, accounts, telemetry, or external services.";

export const metadata: Metadata = {
  title,
  description,
  // The .ico is marked 32x32 so browsers that support SVG icons pick the SVG.
  icons: {
    icon: [
      { url: `${basePath}/favicon.ico`, sizes: "32x32" },
      { url: `${basePath}/favicon.svg`, type: "image/svg+xml" },
    ],
    apple: { url: `${basePath}/apple-touch-icon.png`, sizes: "180x180" },
  },
  manifest: `${basePath}/site.webmanifest`,
  openGraph: {
    type: "website",
    siteName: "SpecLift",
    url: siteUrl,
    title,
    description,
    images: [
      {
        url: previewImage,
        width: 1731,
        height: 909,
        alt: "SpecLift Swagger 2.0 to OpenAPI 3 converter",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
    images: [previewImage],
  },
};

export const viewport: Viewport = {
  themeColor: "#070a12",
  colorScheme: "dark",
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
