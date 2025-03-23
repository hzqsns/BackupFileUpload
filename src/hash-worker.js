// 注意：在Vite中，worker内可以直接使用ES模块导入
import SparkMD5 from 'spark-md5';

// 将FileReader包装成Promise
function readAsArrayBuffer(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => resolve(e.target.result);
    reader.onerror = e => reject(e.target.error);
    reader.readAsArrayBuffer(blob);
  });
}

// 监听主线程消息
self.onmessage = async function(e) {
  const { fileChunk, chunkIndex } = e.data;
  
  try {
    // 直接读取整个文件分片
    const arrayBuffer = await readAsArrayBuffer(fileChunk);
    
    // 使用SparkMD5计算整个分片的哈希
    const spark = new SparkMD5.ArrayBuffer();
    spark.append(arrayBuffer);
    
    // 返回结果给主线程
    self.postMessage({
      chunkIndex,
      hash: spark.end(),
      success: true
    });
  } catch (error) {
    self.postMessage({
      chunkIndex,
      error: error.message,
      success: false
    });
  }
}; 