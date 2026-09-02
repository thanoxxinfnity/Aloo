import Head from 'next/head';
import '@/styles/globals.css';

export default function AlooApp({ Component, pageProps }) {
  return (
    <>
      <Head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover" />
        <meta name="theme-color" content="#0b0f19" />
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        <meta
          name="description"
          content="ALOO — a Year 2100 3D interactive AI assistant with a rigged WebGL avatar, real-time voice, live vision and multi-LLM routing."
        />
        {/* The HUD font is loaded in _document.jsx — Next rejects stylesheet
            links placed in a page's Head. */}
      </Head>
      <Component {...pageProps} />
    </>
  );
}
