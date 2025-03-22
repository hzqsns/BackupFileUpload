// 注意：在Vite中，worker内可以直接使用ES模块导入
import SparkMD5 from 'spark-md5';

// 监听主线程消息
self.onmessage = async function(e) {
  const { fileChunk, chunkIndex } = e.data;
  
  try {
    // 使用SparkMD5计算哈希
    const spark = new SparkMD5.ArrayBuffer();
    const reader = new FileReader();
    
    // 使用Promise封装FileReader
    const hash = await new Promise((resolve, reject) => {
      reader.onload = function(e) {
        spark.append(e.target.result);
        resolve(spark.end());
      };
      
      reader.onerror = function() {
        reject(new Error('文件读取失败'));
      };
      
      reader.readAsArrayBuffer(fileChunk);
    });
    
    // 返回结果给主线程
    self.postMessage({
      chunkIndex,
      hash,
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