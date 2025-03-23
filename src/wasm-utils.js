/**
 * WebAssembly 工具函数
 * 
 * 此文件提供WebAssembly支持检测和初始化功能，用于确保hash-wasm库
 * 可以在各种浏览器环境中正确加载和运行。
 */

// 检测浏览器是否支持WebAssembly
export function isWebAssemblySupported() {
  try {
    // 检查WebAssembly对象是否存在
    if (typeof WebAssembly === 'undefined') {
      console.warn('此浏览器不支持WebAssembly');
      return false;
    }

    // 检查必要的方法是否可用
    if (typeof WebAssembly.instantiate !== 'function' ||
        typeof WebAssembly.compile !== 'function') {
      console.warn('WebAssembly API不完整');
      return false;
    }

    // 尝试编译一个简单的WebAssembly模块
    const module = new WebAssembly.Module(new Uint8Array([
      0, 97, 115, 109, 1, 0, 0, 0 // 简单的WASM头部 "\0asm\1\0\0\0"
    ]));
    
    if (!(module instanceof WebAssembly.Module)) {
      console.warn('WebAssembly模块编译失败');
      return false;
    }

    // 尝试创建一个WebAssembly实例
    const instance = new WebAssembly.Instance(module);
    
    if (!(instance instanceof WebAssembly.Instance)) {
      console.warn('WebAssembly实例化失败');
      return false;
    }

    return true;
  } catch (e) {
    console.warn('WebAssembly测试失败:', e);
    return false;
  }
}

// 尝试初始化hash-wasm库
export async function initHashWasm() {
  // 首先检查WebAssembly支持
  const wasmSupported = isWebAssemblySupported();
  console.log('WebAssembly支持状态:', wasmSupported ? '支持' : '不支持');
  
  if (!wasmSupported) {
    return {
      success: false,
      reason: 'WebAssembly不被支持',
      useFallback: true
    };
  }
  
  try {
    // 尝试动态导入hash-wasm库
    const hashWasm = await import('hash-wasm');
    
    // 尝试预热一下MD5函数，确保WebAssembly模块加载成功
    await hashWasm.md5('test');
    
    return {
      success: true,
      library: hashWasm,
      reason: 'hash-wasm初始化成功'
    };
  } catch (error) {
    console.error('hash-wasm初始化失败:', error);
    
    return {
      success: false,
      error,
      reason: `hash-wasm初始化失败: ${error.message || '未知错误'}`,
      useFallback: true
    };
  }
}

// 获取正确的WebAssembly文件路径（用于Worker中）
export function getWorkerWasmPath() {
  // 如果是开发环境
  if (import.meta.env.DEV) {
    return '/node_modules/hash-wasm/dist/';
  }
  
  // 如果是生产环境，基于baseUrl计算
  const baseUrl = document.querySelector('base')?.getAttribute('href') || '/';
  return `${baseUrl}assets/wasm/`;
}

export default {
  isWebAssemblySupported,
  initHashWasm,
  getWorkerWasmPath
}; 