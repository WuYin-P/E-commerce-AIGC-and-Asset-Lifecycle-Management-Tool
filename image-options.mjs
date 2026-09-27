import { fail } from './store.mjs';

export const sizes = { '1:1': '1024x1024', '3:4': '1152x1536', '4:3': '1536x1152', '2:3': '1024x1536', '3:2': '1536x1024', '9:16': '864x1536', '16:9': '1536x864' };
// Curated presets, not an exhaustive list or a live capability-discovery response.
// https://help.aliyun.com/zh/model-studio/qwen-image-generation-and-editing-api-reference
// T2I/I2I: 512²–2048² pixels, aspect ratio 1:8–8:1.
const highSizes = { '1:1': '2048x2048', '3:4': '1536x2048', '4:3': '2048x1536', '2:3': '1664x2496', '3:2': '2496x1664', '9:16': '1440x2560', '16:9': '2560x1440' };

export function imageOptions(config) {
  const adapted = config.provider === 'dashscope' && ['qwen-image-3.0-pro', 'qwen-image-3.0'].includes(config.model);
  return {
    adapted,
    model: config.model || '',
    defaultResolution: 'standard',
    resolutions: [
      { id: 'standard', label: adapted ? '1K' : '默认尺寸', sizes },
      ...(adapted ? [{ id: 'high', label: '2K', sizes: highSizes }] : []),
    ],
  };
}

export function resolveImageSize(config, ratio, resolution = 'standard') {
  const preset = imageOptions(config).resolutions.find(item => item.id === resolution);
  if (!preset || !Object.hasOwn(preset.sizes, ratio)) throw fail('当前模型不支持所选比例或分辨率，请重新选择。');
  return { resolution: preset.id, resolutionLabel: preset.label, size: preset.sizes[ratio] };
}
