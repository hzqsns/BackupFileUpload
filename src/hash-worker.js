// Worker文件：优先使用hash-wasm，优雅降级为SparkMD5
import SparkMD5 from 'spark-md5';

// 尝试动态导入hash-wasm，避免加载失败时阻塞整个worker
let hashWasm = null;
let hashWasmLoadError = null;
let wasmInitialized = false;

// 尝试加载hash-wasm库
async function loadHashWasm() {
  if (hashWasm !== null) {
    return wasmInitialized;
  }
  
  try {
    // 设置WebAssembly实例化选项，增加跨源隔离配置
    if (typeof WebAssembly !== 'undefined' && 
        typeof WebAssembly.instantiateStreaming === 'function') {
      const originalInstantiateStreaming = WebAssembly.instantiateStreaming;
      WebAssembly.instantiateStreaming = async (response, importObject) => {
        const clonedResponse = response.clone();
        try {
          return await originalInstantiateStreaming(response, importObject);
        } catch (e) {
          // 如果失败，尝试通过arrayBuffer方式加载
          const buffer = await clonedResponse.arrayBuffer();
          return WebAssembly.instantiate(buffer, importObject);
        }
      };
    }
    
    // 导入hash-wasm库
    const module = await import('hash-wasm');
    hashWasm = module;
    
    // 尝试预热一下MD5函数，确保WebAssembly模块加载成功
    await hashWasm.md5('test');
    wasmInitialized = true;
    
    return true;
  } catch (error) {
    console.warn('加载hash-wasm库失败，将使用SparkMD5作为备选方案', error);
    hashWasmLoadError = error;
    wasmInitialized = false;
    return false;
  }
}

/**
 * 哈希计算实现说明：
 * 
 * 本Worker实现了两种哈希计算方式，优先使用hash-wasm（更快），降级使用SparkMD5：
 * 
 * 1. hash-wasm方式（首选）：
 *    - 使用WebAssembly二进制实现
 *    - 性能比JavaScript实现快5-20倍
 *    - 内存使用效率更高
 *    - 对大文件处理更快
 * 
 * 2. SparkMD5方式（降级备选）：
 *    - 纯JavaScript实现
 *    - 在不支持WebAssembly的环境中作为备选
 *    - 兼容性更好
 * 
 * 自动判断环境支持情况并选择最优实现。
 */

// 使用hash-wasm计算MD5哈希值
async function calculateHashWithWasm(arrayBuffer) {
  if (!hashWasm || !wasmInitialized) {
    throw new Error('hash-wasm库未加载或初始化失败');
  }
  
  try {
    // 使用hash-wasm的md5函数直接计算哈希值
    // 它内部实现了对ArrayBuffer的优化处理
    const result = await hashWasm.md5(new Uint8Array(arrayBuffer));
    return result;
  } catch (error) {
    console.error('hash-wasm计算失败，错误:', error);
    // 如果hash-wasm失败，抛出错误让外层捕获并降级处理
    throw error;
  }
}

// 使用SparkMD5计算MD5哈希值（降级方案）
function calculateHashWithSparkMD5(arrayBuffer) {
  // 创建SparkMD5实例，专门用于处理ArrayBuffer
  const spark = new SparkMD5.ArrayBuffer();
  // 添加数据并计算哈希
  spark.append(arrayBuffer);
  // 返回计算结果
  return spark.end();
}

// 预加载hash-wasm库
loadHashWasm().then(success => {
  if (success) {
    console.log('hash-wasm库加载成功，将使用高性能WebAssembly实现');
  } else {
    console.warn('hash-wasm库加载失败，将使用SparkMD5备选方案');
  }
}).catch(err => {
  console.error('预加载hash-wasm库失败:', err);
});

// 监听主线程消息
self.onmessage = async function(e) {
  const { arrayBuffer, chunkIndex } = e.data;
  
  try {
    let hash;
    let hashImplementation;
    
    // 如果之前未尝试加载hash-wasm，先尝试加载
    if (!hashWasm && chunkIndex === 0) {
      await loadHashWasm().catch(() => {});
    }
    
    // 首先尝试使用hash-wasm（性能更优）
    if (wasmInitialized) {
      try {
        hash = await calculateHashWithWasm(arrayBuffer);
        hashImplementation = "hash-wasm (WebAssembly)";
        
        // 记录正在使用hash-wasm
        if (chunkIndex === 0) {
          console.log('正在使用hash-wasm进行高性能哈希计算');
        }
      } catch (wasmError) {
        console.warn('使用hash-wasm计算失败，降级到SparkMD5', wasmError);
        hash = calculateHashWithSparkMD5(arrayBuffer);
        hashImplementation = "SparkMD5 (JavaScript) - WASM执行失败";
      }
    } else {
      // hash-wasm加载失败或未初始化，使用SparkMD5
      hash = calculateHashWithSparkMD5(arrayBuffer);
      hashImplementation = "SparkMD5 (JavaScript) - WASM不可用";
      
      // 记录已降级到SparkMD5
      if (chunkIndex === 0) {
        console.warn('WebAssembly不可用或出错，已降级为SparkMD5进行哈希计算', hashWasmLoadError);
      }
    }
    
    // 返回结果给主线程
    self.postMessage({
      chunkIndex,
      hash: hash,
      success: true,
      hashImplementation: hashImplementation // 添加使用的哈希实现信息
    });
  } catch (error) {
    console.error('哈希计算完全失败:', error);
    self.postMessage({
      chunkIndex,
      error: error.message || '未知错误',
      success: false,
      hashImplementation: "计算失败"
    });
  }
}; 