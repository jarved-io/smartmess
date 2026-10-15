import "./globals.css";

export const metadata = {
  title: "My Next.js App",
  description: "Next.js + Prisma + Postgres, deployed on Vercel",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
