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
 * 1. hash-wasm方式（首选）：WebAssembly实现，性能比JS快5-20倍
 * 2. SparkMD5方式（备选）：纯JavaScript实现
 * 
 * 同时，每种实现都有两种数据处理模式：
 * 1. Stream流式处理（首选）：内存效率更高，适合大文件
 * 2. ArrayBuffer一次性处理（备选）：简单但内存消耗大
 */

// =========================== Stream流方式（新方法）===========================

/**
 * 使用Stream流方式计算MD5哈希（hash-wasm实现）
 * 优点：内存使用更高效，适合大文件，避免一次性加载大块数据
 */
async function calculateHashWithWasmStream(chunkData, chunkSize = 2097152) {
  if (!hashWasm || !wasmInitialized) {
    throw new Error('hash-wasm库未加载或初始化失败');
  }
  
  try {
    // 如果传入的是ArrayBuffer，需要转换为Blob
    const blob = chunkData instanceof ArrayBuffer 
      ? new Blob([chunkData]) 
      : chunkData;
    
    // 创建hash-wasm的增量哈希实例
    const hasher = await hashWasm.createMD5();
    
    // 获取文件流
    const stream = blob.stream();
    const reader = stream.getReader();
    
    // 读取并处理流
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      // 更新哈希值
      hasher.update(value);
    }
    
    // 完成哈希计算并返回结果
    return hasher.digest('hex');
  } catch (error) {
    console.error('hash-wasm流式计算失败，错误:', error);
    throw error;
  }
}

/**
 * 使用Stream流方式计算MD5哈希（SparkMD5实现）
 * 这是降级方案，当hash-wasm不可用时使用
 */
async function calculateHashWithSparkMD5Stream(chunkData, chunkSize = 2097152) {
  try {
    // 如果传入的是ArrayBuffer，转换为Blob
    const blob = chunkData instanceof ArrayBuffer 
      ? new Blob([chunkData]) 
      : chunkData;
    
    // 创建SparkMD5实例
    const spark = new SparkMD5.ArrayBuffer();
    
    // 分段读取文件处理
    const fileReader = new FileReader();
    const totalChunks = Math.ceil(blob.size / chunkSize);
    
    // 封装一个Promise，读取整个Blob
    return new Promise((resolve, reject) => {
      let currentChunk = 0;
      
      fileReader.onload = (e) => {
        spark.append(e.target.result);
        currentChunk++;
        
        if (currentChunk < totalChunks) {
          // 继续读取下一块
          loadNext();
        } else {
          // 完成计算
          resolve(spark.end());
        }
      };
      
      fileReader.onerror = reject;
      
      // 加载下一块数据
      function loadNext() {
        const start = currentChunk * chunkSize;
        const end = Math.min(blob.size, start + chunkSize);
        const chunk = blob.slice(start, end);
        fileReader.readAsArrayBuffer(chunk);
      }
      
      // 开始读取第一块
      loadNext();
    });
  } catch (error) {
    console.error('SparkMD5流式计算失败，错误:', error);
    throw error;
  }
}

// =========================== ArrayBuffer方式（原方法，已注释）===========================

/*
// 使用hash-wasm计算MD5哈希值（一次性加载整个ArrayBuffer）
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

// 使用SparkMD5计算MD5哈希值（一次性处理，降级方案）
function calculateHashWithSparkMD5(arrayBuffer) {
  // 创建SparkMD5实例，专门用于处理ArrayBuffer
  const spark = new SparkMD5.ArrayBuffer();
  // 添加数据并计算哈希
  spark.append(arrayBuffer);
  // 返回计算结果
  return spark.end();
}
*/

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
  // 接收数据，支持blob或arrayBuffer两种模式
  const { blob, arrayBuffer, chunkIndex } = e.data;
  
  // 确定实际的数据源（优先使用blob）
  const chunkData = blob || arrayBuffer;
  
  if (!chunkData) {
    self.postMessage({
      chunkIndex,
      error: '未接收到数据',
      success: false,
      hashImplementation: "数据错误"
    });
    return;
  }
  
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
        // 使用流式计算
        hash = await calculateHashWithWasmStream(chunkData);
        hashImplementation = "hash-wasm Stream (WebAssembly)";
        
        // 记录正在使用hash-wasm
        if (chunkIndex === 0) {
          console.log('正在使用hash-wasm流式方法进行高性能哈希计算');
        }
      } catch (wasmError) {
        console.warn('使用hash-wasm流式计算失败，降级到SparkMD5', wasmError);
        hash = await calculateHashWithSparkMD5Stream(chunkData);
        hashImplementation = "SparkMD5 Stream (JavaScript) - WASM执行失败";
      }
    } else {
      // hash-wasm加载失败或未初始化，使用SparkMD5
      hash = await calculateHashWithSparkMD5Stream(chunkData);
      hashImplementation = "SparkMD5 Stream (JavaScript) - WASM不可用";
      
      // 记录已降级到SparkMD5
      if (chunkIndex === 0) {
        console.warn('WebAssembly不可用或出错，已降级为SparkMD5流式计算', hashWasmLoadError);
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