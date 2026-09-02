import { Html, Head, Main, NextScript } from 'next/document';

/**
 * Stylesheets belong here, not in next/head — Next warns about (and can
 * double-inject) <link rel="stylesheet"> placed in a page's Head.
 */
export default function Document() {
  return (
    <Html lang="en">
      <Head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;600&display=swap"
          rel="stylesheet"
        />
      </Head>
      <body className="bg-abyss">
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
