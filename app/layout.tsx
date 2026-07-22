import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Island Murphy Beds Checkout",
  description: "Secure 50% deposit checkout for configured Murphy bed orders.",
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
