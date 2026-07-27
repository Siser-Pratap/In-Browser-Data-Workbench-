import type { Metadata, Viewport } from 'next';

import { ThemeProvider } from '@/components/layout/ThemeProvider';
import { Toaster } from '@/components/layout/Toaster';

import './globals.css';

export const metadata: Metadata = {
  title: 'Data Workbench',
  description:
    'Query CSV, Excel, Parquet and JSON files with SQL — entirely in your browser. ' +
    'Your data never leaves your machine.',
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#fdfdfd' },
    { media: '(prefers-color-scheme: dark)', color: '#191b20' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/*
          Apply the stored theme before first paint. Zustand's persisted state
          isn't readable until React hydrates, and without this the app renders
          one light frame before flipping to dark.
        */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var s=localStorage.getItem('workbench-ui');var t=s?JSON.parse(s).state.theme:'dark';if(t==='dark')document.documentElement.classList.add('dark');}catch(e){document.documentElement.classList.add('dark');}})();`,
          }}
        />
      </head>
      <body className="h-full">
        <ThemeProvider>{children}</ThemeProvider>
        <Toaster />
      </body>
    </html>
  );
}
