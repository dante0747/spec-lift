import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host =
    requestHeaders.get("x-forwarded-host")?.split(",")[0].trim() ||
    requestHeaders.get("host") ||
    "localhost";
  const protocol =
    requestHeaders.get("x-forwarded-proto")?.split(",")[0].trim() ||
    (host.startsWith("localhost") ? "http" : "https");
  const origin = `${protocol}://${host}`;
  const title = "SpecLift — Private Swagger 2 to OpenAPI 3 Converter";
  const description =
    "Convert Swagger 2 JSON to OpenAPI 3.0.3 entirely in your browser. No uploads, accounts, telemetry, or external services.";
  const previewImage = new URL(`${basePath}/og.png`, origin).toString();

  return {
    title,
    description,
    icons: {
      icon: `${basePath}/favicon.svg`,
      shortcut: `${basePath}/favicon.svg`,
    },
    openGraph: {
      type: "website",
      siteName: "SpecLift",
      title,
      description,
      images: [
        {
          url: previewImage,
          width: 1731,
          height: 909,
          alt: "SpecLift Swagger 2.0 to OpenAPI 3.0.3 converter",
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
}

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
