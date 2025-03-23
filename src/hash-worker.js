// 注意：在Vite中，worker内可以直接使用ES模块导入
import SparkMD5 from 'spark-md5';

/**
 * 哈希计算方法说明：
 * 
 * SparkMD5提供了两种计算ArrayBuffer哈希的方式：
 * 
 * 1. 增量方式（实例方法）：
 *    - 创建SparkMD5.ArrayBuffer实例
 *    - 使用append()方法添加数据
 *    - 使用end()方法获取最终哈希值
 *    - 原理：维护内部状态，直接处理数据流，减少中间对象创建
 *    - 优势：更高效，内存占用更少，适合处理单个大块数据
 * 
 * 2. 静态方法：
 *    - 直接调用SparkMD5.ArrayBuffer.hash(arrayBuffer)
 *    - 原理：内部会创建临时SparkMD5实例，封装了创建和计算过程
 *    - 劣势：有额外的函数调用和对象创建开销，性能略低
 * 
 * 对于分片哈希计算，增量方式更高效，因为每个分片只需计算一次，
 * 不需要静态方法带来的便利性（适合需要一行代码解决的场景）。
 */

// 监听主线程消息
self.onmessage = async function(e) {
  const { arrayBuffer, chunkIndex } = e.data;
  
  try {
    // 使用增量方式计算哈希（性能更优）
    // 1. 创建SparkMD5实例，专门用于处理ArrayBuffer
    const spark = new SparkMD5.ArrayBuffer();
    
    // 2. 添加数据到哈希计算器
    // 这比静态方法更高效，因为没有额外的函数调用开销
    spark.append(arrayBuffer);
    
    // 3. 完成哈希计算并获取结果
    // end()方法会返回最终的MD5哈希值（32位十六进制字符串）
    const hash = spark.end();
    
    // 返回结果给主线程
    self.postMessage({
      chunkIndex,
      hash: hash,
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