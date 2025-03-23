/**
 * WorkerPool - 线程池管理类
 * 
 * 提供Web Worker线程池管理，自动根据CPU核心数确定线程数量，
 * 并提供任务分配、取消和销毁等功能。
 * 
 * @author Claude
 * @version 1.0.0
 */

class WorkerPool {
  /**
   * 创建一个新的工作线程池
   * 
   * @param {string|URL} workerScript - Worker脚本的URL
   * @param {Object} options - 配置选项
   * @param {number} [options.maxWorkers] - 最大工作线程数，默认为CPU核心数
   * @param {boolean} [options.isModule] - 是否以ES模块方式加载Worker
   */
  constructor(workerScript, options = {}) {
    if (!workerScript) {
      throw new Error('Worker脚本路径不能为空');
    }

    // 配置选项
    this.workerScript = workerScript;
    this.isModule = options.isModule || false;
    
    // 确定最大线程数
    // 使用navigator.hardwareConcurrency获取CPU核心数
    // 如果浏览器不支持或未定义，则默认使用4个线程
    const defaultWorkers = typeof navigator !== 'undefined' && navigator.hardwareConcurrency 
      ? navigator.hardwareConcurrency 
      : 4;
    
    this.maxWorkers = options.maxWorkers || defaultWorkers;
    console.log(`创建工作线程池，最大线程数: ${this.maxWorkers}`);
    
    // 初始化工作线程池
    this.workers = [];
    this.idleWorkers = []; // 空闲的工作线程索引
    this.tasks = [];       // 待处理任务队列
    this.taskMap = new Map(); // 任务ID到Promise的映射
    
    // 创建工作线程
    this.createWorkers();
  }
  
  /**
   * 创建工作线程
   * @private
   */
  createWorkers() {
    for (let i = 0; i < this.maxWorkers; i++) {
      try {
        // 创建Worker，支持ES模块
        const worker = new Worker(this.workerScript, {
          type: this.isModule ? 'module' : 'classic'
        });
        
        // 设置消息处理函数
        worker.onmessage = this.createMessageHandler(i);
        worker.onerror = this.createErrorHandler(i);
        
        // 添加到线程池
        this.workers.push({
          worker,
          busy: false,
          currentTaskId: null
        });
        this.idleWorkers.push(i);
      } catch (error) {
        console.error(`创建工作线程 ${i} 失败:`, error);
      }
    }
  }
  
  /**
   * 为工作线程创建消息处理函数
   * 
   * @param {number} workerIndex - 工作线程索引
   * @returns {Function} 消息处理函数
   * @private
   */
  createMessageHandler(workerIndex) {
    return (event) => {
      const workerInfo = this.workers[workerIndex];
      
      if (!workerInfo || !workerInfo.currentTaskId) {
        return;
      }
      
      const taskId = workerInfo.currentTaskId;
      const task = this.taskMap.get(taskId);
      
      if (task) {
        // 解析任务的Promise
        task.resolve(event.data);
        this.taskMap.delete(taskId);
      }
      
      // 标记工作线程为空闲
      workerInfo.busy = false;
      workerInfo.currentTaskId = null;
      this.idleWorkers.push(workerIndex);
      
      // 处理下一个任务
      this.processNextTask();
    };
  }
  
  /**
   * 为工作线程创建错误处理函数
   * 
   * @param {number} workerIndex - 工作线程索引
   * @returns {Function} 错误处理函数
   * @private
   */
  createErrorHandler(workerIndex) {
    return (error) => {
      const workerInfo = this.workers[workerIndex];
      
      if (!workerInfo || !workerInfo.currentTaskId) {
        console.error(`工作线程 ${workerIndex} 错误:`, error);
        return;
      }
      
      const taskId = workerInfo.currentTaskId;
      const task = this.taskMap.get(taskId);
      
      if (task) {
        // 拒绝任务的Promise
        task.reject(error);
        this.taskMap.delete(taskId);
      }
      
      // 标记工作线程为空闲
      workerInfo.busy = false;
      workerInfo.currentTaskId = null;
      this.idleWorkers.push(workerIndex);
      
      // 处理下一个任务
      this.processNextTask();
    };
  }
  
  /**
   * 执行任务
   * 
   * @param {*} data - 发送给工作线程的数据
   * @param {Array} [transferList] - 可转移对象列表
   * @returns {Promise<*>} 任务完成后的结果
   */
  exec(data, transferList = []) {
    return new Promise((resolve, reject) => {
      const taskId = this.generateTaskId();
      
      // 创建任务
      const task = {
        id: taskId,
        data,
        transferList,
        resolve,
        reject
      };
      
      // 保存任务
      this.taskMap.set(taskId, task);
      
      // 添加到任务队列
      this.tasks.push(task);
      
      // 尝试立即处理任务
      this.processNextTask();
    });
  }
  
  /**
   * 处理下一个待处理任务
   * @private
   */
  processNextTask() {
    // 如果没有空闲工作线程或没有待处理任务，则返回
    if (this.idleWorkers.length === 0 || this.tasks.length === 0) {
      return;
    }
    
    // 获取一个空闲工作线程
    const workerIndex = this.idleWorkers.shift();
    const workerInfo = this.workers[workerIndex];
    
    // 获取一个待处理任务
    const task = this.tasks.shift();
    
    // 分配任务给工作线程
    workerInfo.busy = true;
    workerInfo.currentTaskId = task.id;
    
    try {
      // 发送数据到工作线程
      workerInfo.worker.postMessage(task.data, task.transferList);
    } catch (error) {
      console.error('发送任务到工作线程失败:', error);
      
      // 处理错误
      task.reject(error);
      this.taskMap.delete(task.id);
      
      // 将工作线程标记为空闲
      workerInfo.busy = false;
      workerInfo.currentTaskId = null;
      this.idleWorkers.push(workerIndex);
      
      // 继续处理下一个任务
      this.processNextTask();
    }
  }
  
  /**
   * 生成唯一的任务ID
   * 
   * @returns {string} 唯一任务ID
   * @private
   */
  generateTaskId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
  }
  
  /**
   * 获取当前活跃(忙碌)的工作线程数量
   * 
   * @returns {number} 活跃工作线程数
   */
  getActiveWorkerCount() {
    return this.workers.filter(w => w.busy).length;
  }
  
  /**
   * 获取当前待处理任务数量
   * 
   * @returns {number} 待处理任务数
   */
  getPendingTaskCount() {
    return this.tasks.length;
  }
  
  /**
   * 终止所有工作线程并清理资源
   */
  terminate() {
    // 拒绝所有未完成的任务
    this.tasks.forEach(task => {
      task.reject(new Error('工作线程池已终止'));
    });
    
    // 清空任务队列
    this.tasks = [];
    this.taskMap.clear();
    
    // 终止所有工作线程
    this.workers.forEach(workerInfo => {
      if (workerInfo.worker) {
        workerInfo.worker.terminate();
      }
    });
    
    // 清空工作线程池
    this.workers = [];
    this.idleWorkers = [];
    
    console.log('工作线程池已终止');
  }
}

export default WorkerPool; 