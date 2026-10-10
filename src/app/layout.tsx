import type { Metadata } from "next";
import { Tajawal } from "next/font/google";
import "./globals.css";
import VisualEditsMessenger from "../visual-edits/VisualEditsMessenger";
import ErrorReporter from "@/components/ErrorReporter";
import Script from "next/script";
import { ClientProviders } from "@/components/ClientProviders";
import { Toaster } from "@/components/ui/sonner";

const tajawal = Tajawal({
  subsets: ["arabic"],
  weight: ["200", "300", "400", "500", "700", "800", "900"],
  variable: "--font-tajawal",
});

export const metadata: Metadata = {
  title: {
    default: "SPEED Car Rental — تأجير وبيع السيارات في البحرين",
    template: "%s | SPEED Car Rental",
  },
  description:
    "SPEED Car Rental — تأجير وبيع السيارات في مملكة البحرين. أسطول حديث، خدمة استثنائية، ونظام SPEED ERP لإدارة الأعمال.",
  applicationName: "SPEED Car Rental",
  keywords: [
    "SPEED",
    "car rental",
    "تأجير سيارات",
    "البحرين",
    "Bahrain",
    "SPEED ERP",
    "نظام ERP",
  ],
  openGraph: {
    title: "SPEED Car Rental — Car Rental & Sales in Bahrain",
    description:
      "Bahrain's premier car rental and sales — and SPEED ERP for managing your business.",
    siteName: "SPEED Car Rental",
    type: "website",
  },
  twitter: {
    card: "summary",
    title: "SPEED Car Rental",
    description:
      "Car rental and sales in Bahrain, plus SPEED ERP for business management.",
  },
  icons: {
    icon: "/favicon.ico",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ar" dir="rtl" className={`${tajawal.variable} font-tajawal`}>
      <body className="antialiased font-tajawal">
        <ClientProviders>
          <Script
            id="orchids-browser-logs"
            src="https://slelguoygbfzlpylpxfs.supabase.co/storage/v1/object/public/scripts/orchids-browser-logs.js"
            strategy="afterInteractive"
            data-orchids-project-id="b712b857-7184-4bb1-bc02-5ada297a7ef4"
          />
          <ErrorReporter />
          <Script
            src="https://slelguoygbfzlpylpxfs.supabase.co/storage/v1/object/public/scripts//route-messenger.js"
            strategy="afterInteractive"
            data-target-origin="*"
            data-message-type="ROUTE_CHANGE"
            data-include-search-params="true"
            data-only-in-iframe="true"
            data-debug="true"
            data-custom-data='{"appName": "YourApp", "version": "1.0.0", "greeting": "hi"}'
          />
          {children}
          <Toaster />
          <VisualEditsMessenger />
        </ClientProviders>
      </body>
    </html>
  );
}
