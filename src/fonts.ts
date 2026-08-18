import { staticFile } from 'remotion';

const style = document.createElement('style');
style.textContent = `
  @font-face {
    font-family: 'Noto Sans TC';
    font-weight: 400;
    src: url('${staticFile('NotoSansTC-Regular.ttf')}') format('truetype');
  }
  @font-face {
    font-family: 'Noto Sans TC';
    font-weight: 700;
    src: url('${staticFile('NotoSansTC-Bold.ttf')}') format('truetype');
  }
`;
document.head.appendChild(style);
