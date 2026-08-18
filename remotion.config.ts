import { Config } from '@remotion/cli/config';

// 渲染影像格式（jpeg 較快、png 較佳品質）
Config.setVideoImageFormat('jpeg');

// 每次 render 覆寫舊輸出
Config.setOverwriteOutput(true);

// 預設輸出位置（可選）
// Config.setOutputLocation('out/video.mp4');
