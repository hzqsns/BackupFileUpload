/**
 * HashWorkerPool - 专门用于哈希计算的工作线程池
 * 
 * 基于通用线程池实现的哈希计算专用线程池，提供针对文件分片的哈希计算功能，
 * 支持在主线程中进行Blob到ArrayBuffer的转换，并使用转移对象优化内存使用。
 * 
 * 优先使用hash-wasm进行高性能哈希计算，在不支持WebAssembly的环境下优雅降级为SparkMD5。
 * hash-wasm库使用手工优化的WebAssembly二进制文件，比传统JavaScript实现快5-20倍。
 * 
 * @author Claude
 * @version 1.1.0
 */

import WorkerPool from './worker-pool.js';

// Worker处理完成后的回调处理
function handleWorkerMessage(event, resolve, chunkIndex, recordTime) {
  const result = event.data;
  const endTime = Date.now();
  const processingTime = endTime - recordTime;
  
  // 记录第一个Worker的哈希实现方式
  if (this._wasmStatus === 'unknown' && result.hashImplementation) {
    this._wasmStatus = result.hashImplementation.includes('WebAssembly') ? 'wasm' : 'js';
    console.log(`哈希计算使用的实现: ${result.hashImplementation}`);
  }
  
  // 记录处理时间
  this._statistics.chunkTimes.push({
    chunkIndex,
    time: processingTime
  });
  
  resolve(result);
}

// 类定义开始
export default class HashWorkerPool {
  /**
   * 创建一个哈希计算专用的线程池
   * 
   * @param {Object} options - 配置选项
   * @param {number} [options.maxWorkers] - 最大工作线程数，默认为CPU核心数
   */
  constructor(options = {}) {
    // 使用import.meta.url获取当前模块的URL
    // 使用new URL()来解析hash-worker.js相对于当前模块的路径
    const workerScript = new URL('./hash-worker.js', import.meta.url);
    
    // 创建工作线程池，使用ES模块方式加载
    this.pool = new WorkerPool(workerScript, {
      maxWorkers: options.maxWorkers,
      isModule: true
    });
    
    // 哈希计算统计
    this.stats = {
      totalChunks: 0,
      processedChunks: 0,
      startTime: 0,
      endTime: 0,
      totalTime: 0,
      chunkTimes: [],
      hashImplementation: 'unknown' // 记录使用的哈希实现
    };
    
    this._wasmStatus = 'unknown'; // WebAssembly状态: unknown, wasm, js
    
    console.log(`创建哈希计算线程池，使用优先级：1.hash-wasm(WebAssembly实现) 2.SparkMD5(降级方案)`);
  }
  
  /**
   * 计算单个文件分片的哈希值
   * 
   * @param {Blob} fileChunk - 文件分片
   * @param {number} chunkIndex - 分片索引
   * @returns {Promise<Object>} 包含哈希值和分片索引的对象
   */
  async computeChunkHash(fileChunk, chunkIndex) {
    try {
      // 在主线程中将Blob转换为ArrayBuffer
      // 这样可以避免在Worker中进行转换，也避免了结构化克隆Blob对象
      const arrayBuffer = await fileChunk.arrayBuffer();
      
      // 记录开始时间用于计算处理时间
      const startTime = Date.now();
      
      // 使用transfer方式发送ArrayBuffer给工作线程
      // 这会使主线程中的arrayBuffer变为不可用，但避免了数据复制
      const result = await this.pool.exec({
        arrayBuffer,
        chunkIndex
      }, [arrayBuffer]); // 第二个参数是transferList
      
      // 计算处理时间
      const endTime = Date.now();
      const processingTime = endTime - startTime;
      
      // 记录处理时间
      this.stats.chunkTimes.push({
        chunkIndex,
        time: processingTime
      });
      
      // 记录使用的哈希实现方式
      if (result && result.hashImplementation) {
        if (this._wasmStatus === 'unknown') {
          this._wasmStatus = result.hashImplementation.includes('WebAssembly') ? 'wasm' : 'js';
          console.log(`哈希计算使用的实现: ${result.hashImplementation}`);
        }
      }
      
      return result;
    } catch (error) {
      console.error(`计算分片 ${chunkIndex} 哈希值失败:`, error);
      throw error;
    }
  }
  
  /**
   * 计算多个文件分片的哈希值
   * 
   * @param {Array<{data: Blob, index: number}>} chunks - 分片数据和索引的数组
   * @param {Object} options - 计算选项
   * @param {Function} [options.onProgress] - 进度回调函数
   * @param {Function} [options.onComplete] - 完成回调函数，接收统计数据作为参数
   * @returns {Promise<Array>} 哈希计算结果数组
   */
  async computeHashesForChunks(chunks, options = {}) {
    // 重置统计信息
    this.stats = {
      totalChunks: chunks.length,
      processedChunks: 0,
      startTime: Date.now(),
      endTime: 0,
      totalTime: 0,
      chunkTimes: [],
      hashImplementation: 'unknown'
    };
    
    try {
      // 创建一个Promise数组，每个Promise处理一个分片
      const promises = chunks.map(async (chunk) => {
        const result = await this.computeChunkHash(chunk.data, chunk.index);
        
        // 更新统计信息和进度
        this.stats.processedChunks++;
        const progress = (this.stats.processedChunks / this.stats.totalChunks) * 100;
        
        // 如果有进度回调，调用它
        if (options.onProgress) {
          options.onProgress({
            chunkIndex: chunk.index,
            progress,
            result
          });
        }
        
        return result;
      });
      
      // 等待所有计算完成
      const results = await Promise.all(promises);
      
      // 更新统计信息
      this.stats.endTime = Date.now();
      this.stats.totalTime = this.stats.endTime - this.stats.startTime;
      
      // 确定使用的哈希实现
      if (this._wasmStatus === 'wasm') {
        this.stats.hashImplementation = 'wasm';
      } else if (this._wasmStatus === 'js') {
        this.stats.hashImplementation = 'js';
      }
      
      // 计算并显示性能统计
      const stats = this.logPerformanceStats();
      
      // 如果有完成回调，调用它
      if (typeof options.onComplete === 'function') {
        options.onComplete(stats);
      }
      
      return results;
    } catch (error) {
      console.error('哈希计算过程中出错:', error);
      throw error;
    }
  }
  
  /**
   * 记录性能统计信息
   * @private
   */
  logPerformanceStats() {
    const { totalChunks, totalTime, chunkTimes } = this.stats;
    const averageTime = totalTime / totalChunks;
    const maxTime = Math.max(...chunkTimes.map(item => item.time));
    const minTime = Math.min(...chunkTimes.map(item => item.time));
    const theoreticalSerialTime = chunkTimes.reduce((sum, item) => sum + item.time, 0);
    const parallelSpeedup = theoreticalSerialTime / totalTime;
    
    console.log('哈希计算性能统计:');
    console.log(`- 总块数: ${totalChunks}`);
    console.log(`- 哈希实现: ${this.stats.hashImplementation === 'wasm' ? 'WebAssembly (快)' : this.stats.hashImplementation === 'js' ? 'JavaScript (慢)' : '未知'}`);
    console.log(`- 总计算时间: ${totalTime.toFixed(2)}ms`);
    console.log(`- 平均每块时间: ${averageTime.toFixed(2)}ms`);
    console.log(`- 最长块时间: ${maxTime.toFixed(2)}ms`);
    console.log(`- 最短块时间: ${minTime.toFixed(2)}ms`);
    console.log(`- 理论串行时间: ${theoreticalSerialTime.toFixed(2)}ms`);
    console.log(`- 并行加速比: ${parallelSpeedup.toFixed(2)}x`);
    
    return {
      totalChunks,
      workerCount: this.pool.maxWorkers,
      hashImplementation: this.stats.hashImplementation,
      totalTime,
      averageTime,
      maxTime,
      minTime,
      theoreticalSerialTime,
      parallelSpeedup
    };
  }
  
  /**
   * 终止哈希计算线程池
   */
  terminate() {
    if (this.pool) {
      this.pool.terminate();
    }
  }
} 