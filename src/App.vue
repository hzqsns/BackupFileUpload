<template>
  <div class="container">
    <h1>大文件上传系统</h1>
    <div class="upload-container">
      <div class="file-selection">
        <input type="file" ref="fileInput" @change="handleFileChange" />
        <button @click="selectFile">选择文件</button>
      </div>
      
      <div class="upload-info" v-if="selectedFile">
        <p>文件名: {{ selectedFile.name }}</p>
        <p>文件大小: {{ formatFileSize(selectedFile.size) }}</p>
        
        <div class="progress-container">
          <div class="progress-bar" :style="{ width: `${uploadProgress}%` }"></div>
          <span>{{ uploadProgress.toFixed(2) }}%</span>
        </div>
        
        <div class="upload-controls">
          <button @click="startUpload" :disabled="isUploading && !isPaused">开始上传</button>
          <button @click="pauseUpload" :disabled="!isUploading || isPaused">暂停上传</button>
          <button @click="resumeUpload" :disabled="!isPaused">恢复上传</button>
          <button @click="cancelUpload" :disabled="!isUploading && !isPaused">取消上传</button>
        </div>
      </div>
      
      <div class="upload-status" v-if="uploadStatus">
        <p>{{ uploadStatus }}</p>
      </div>
    </div>
  </div>
</template>

<script>
export default {
  data() {
    return {
      selectedFile: null,
      chunkSize: 10 * 1024 * 1024, // 每个切片2MB
      chunks: [],
      currentChunkIndex: 0,
      uploadId: null,
      uploadProgress: 0,
      isUploading: false,
      isPaused: false,
      uploadStatus: '',
      controller: null,
      uploadedChunks: [],
      hashWorker: null,
      hashCalculationPromises: {},
      hashProgress: 0,
      isCalculatingHash: false
    }
  },
  methods: {
    selectFile() {
      this.$refs.fileInput.click();
    },
    handleFileChange(e) {
      const file = e.target.files[0];
      if (!file) return;
      
      this.selectedFile = file;
      this.uploadProgress = 0;
      this.isUploading = false;
      this.isPaused = false;
      this.uploadStatus = '';
      this.uploadedChunks = [];
      this.hashCalculationPromises = {};
      this.hashProgress = 0;
      this.prepareChunks();
    },
    prepareChunks() {
      const file = this.selectedFile;
      const chunkCount = Math.ceil(file.size / this.chunkSize);
      this.chunks = [];
      
      for (let i = 0; i < chunkCount; i++) {
        const start = i * this.chunkSize;
        const end = Math.min(file.size, start + this.chunkSize);
        this.chunks.push({
          index: i,
          start,
          end,
          progress: 0,
          status: 'pending', // pending, uploading, paused, completed, failed
          hash: null
        });
      }
      
      this.uploadStatus = `文件已分割为 ${chunkCount} 个分片，准备上传`;
      
      // 计算文件哈希
      this.$nextTick(() => {
        this.calculateChunksHash();
      });
    },
    async calculateChunksHash() {
      // 如果已经在计算中则不重复计算
      if (this.isCalculatingHash) return;
      
      this.isCalculatingHash = true;
      this.uploadStatus = '正在计算文件哈希...';
      this.hashProgress = 0;
      
      // 创建WebWorker
      if (!this.hashWorker) {
        this.hashWorker = new Worker(new URL('./hash-worker.js', import.meta.url), { type: 'module' });
        
        this.hashWorker.onmessage = (e) => {
          const { chunkIndex, hash, success, error } = e.data;
          
          if (success) {
            // 更新分片哈希
            if (this.chunks[chunkIndex]) {
              this.chunks[chunkIndex].hash = hash;
            }
            
            // 解析对应的Promise
            const promise = this.hashCalculationPromises[chunkIndex];
            if (promise && promise.resolve) {
              promise.resolve(hash);
            }
          } else {
            console.error(`分片 ${chunkIndex} 哈希计算失败:`, error);
            
            // 拒绝对应的Promise
            const promise = this.hashCalculationPromises[chunkIndex];
            if (promise && promise.reject) {
              promise.reject(new Error(error));
            }
          }
          
          // 更新哈希计算进度
          this.hashProgress = (Object.keys(this.hashCalculationPromises).filter(
            index => this.chunks[index] && this.chunks[index].hash
          ).length / this.chunks.length) * 100;
          
          if (this.hashProgress >= 100) {
            this.hashProgress = 100;
            this.isCalculatingHash = false;
            this.uploadStatus = `文件哈希计算完成，${this.chunks.length}个分片准备就绪`;
          }
        };
      }
      
      // 为每个分片创建一个Promise，用于等待哈希计算完成
      const hashPromises = [];
      
      for (let i = 0; i < this.chunks.length; i++) {
        const chunk = this.chunks[i];
        
        // 如果已经有哈希值，跳过计算
        if (chunk.hash) continue;
        
        const hashPromise = new Promise((resolve, reject) => {
          this.hashCalculationPromises[i] = { resolve, reject };
          
          const fileChunk = this.selectedFile.slice(chunk.start, chunk.end);
          
          // 将分片发送给Worker计算哈希
          this.hashWorker.postMessage({
            fileChunk,
            chunkIndex: i
          });
        });
        
        hashPromises.push(hashPromise);
      }
      
      try {
        // 等待所有哈希计算完成
        await Promise.all(hashPromises);
      } catch (error) {
        console.error('文件哈希计算失败:', error);
        this.uploadStatus = `文件哈希计算失败: ${error.message}`;
        this.isCalculatingHash = false;
      }
    },
    async startUpload() {
      if (this.isUploading && !this.isPaused) return;
      
      // 如果还在计算哈希，等待完成
      if (this.isCalculatingHash) {
        this.uploadStatus = '正在计算文件哈希，请稍候...';
        return;
      }
      
      // 确保所有分片都有哈希值
      const missingHashChunks = this.chunks.filter(chunk => !chunk.hash);
      if (missingHashChunks.length > 0) {
        this.uploadStatus = '部分文件分片未完成哈希计算，请稍候...';
        await this.calculateChunksHash();
      }
      
      if (!this.uploadId) {
        // 初始化上传
        await this.initUpload();
      }
      
      this.isUploading = true;
      this.isPaused = false;
      this.controller = new AbortController();
      
      this.uploadStatus = '上传中...';
      this.uploadNextChunk();
    },
    async initUpload() {
      try {
        console.log('开始初始化上传...');
        
        // 收集所有分片的哈希值
        const chunksInfo = this.chunks.map(chunk => ({
          index: chunk.index,
          hash: chunk.hash,
          size: chunk.end - chunk.start
        }));
        
        const response = await fetch('/api/upload/init', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            fileName: this.selectedFile.name,
            fileSize: this.selectedFile.size,
            chunkSize: this.chunkSize,
            chunkCount: this.chunks.length,
            chunksInfo: chunksInfo
          })
        });
        
        if (!response.ok) {
          throw new Error(`初始化上传失败: ${response.status} ${response.statusText}`);
        }
        
        const result = await response.json();
        console.log('初始化上传响应:', result);
        
        if (result.code !== 0) {
          throw new Error(result.message || '初始化上传失败');
        }
        
        this.uploadId = result.data.uploadId;
        console.log('获取到的uploadId:', this.uploadId);
        
        // 检查是否有已存在的分片（秒传）
        if (result.data.shouldSkipUpload) {
          console.log('检测到文件已存在，启用秒传...');
          this.uploadStatus = '文件已存在于服务器，秒传成功！';
          this.uploadProgress = 100;
          this.isUploading = false;
          return;
        }
        
        // 如果有已上传的块，标记为已完成
        if (result.data.uploadedChunks && result.data.uploadedChunks.length) {
          this.uploadedChunks = result.data.uploadedChunks;
          this.uploadedChunks.forEach(chunkIndex => {
            if (this.chunks[chunkIndex]) {
              this.chunks[chunkIndex].status = 'completed';
              this.chunks[chunkIndex].progress = 100;
            }
          });
          
          // 找到下一个未上传的块索引
          this.currentChunkIndex = 0;
          while (
            this.currentChunkIndex < this.chunks.length && 
            this.chunks[this.currentChunkIndex].status === 'completed'
          ) {
            this.currentChunkIndex++;
          }
          
          this.calculateTotalProgress();
        }
      } catch (error) {
        console.error('初始化上传出错:', error);
        this.uploadStatus = `初始化上传失败: ${error.message}`;
        throw error; // 重新抛出错误，以便调用者可以捕获
      }
    },
    async uploadNextChunk() {
      if (!this.isUploading || this.isPaused) return;
      
      if (this.currentChunkIndex >= this.chunks.length) {
        // 所有块都已上传完成，进行合并操作
        await this.mergeChunks();
        return;
      }
      
      // 检查uploadId是否有效
      if (!this.uploadId) {
        this.uploadStatus = '上传ID无效，请重新开始上传';
        this.isUploading = false;
        return;
      }
      
      const chunk = this.chunks[this.currentChunkIndex];
      if (chunk.status === 'completed') {
        this.currentChunkIndex++;
        this.uploadNextChunk();
        return;
      }
      
      try {
        chunk.status = 'uploading';
        const file = this.selectedFile;
        const fileChunk = file.slice(chunk.start, chunk.end);
        
        // 创建Blob对象，确保有正确的MIME类型
        const blob = new Blob([fileChunk], { type: file.type || 'application/octet-stream' });
        
        const formData = new FormData();
        // 确保使用'file'作为文件字段名，与服务器端multer配置一致
        formData.append('file', blob, file.name);
        formData.append('uploadId', this.uploadId);
        formData.append('chunkIndex', chunk.index);
        formData.append('chunkHash', chunk.hash);
        formData.append('totalChunks', this.chunks.length);
        
        console.log(`准备上传分片 ${chunk.index + 1}/${this.chunks.length}`, { 
          uploadId: this.uploadId,
          chunkIndex: chunk.index,
          chunkHash: chunk.hash,
          totalChunks: this.chunks.length
        });
        
        const xhr = new XMLHttpRequest();
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            chunk.progress = Math.round((e.loaded / e.total) * 100);
            this.calculateTotalProgress();
          }
        };
        
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            try {
              const response = JSON.parse(xhr.responseText);
              console.log(`分片 ${chunk.index + 1} 上传响应:`, response);
              
              if (response.code === 0) {
                chunk.status = 'completed';
                chunk.progress = 100;
                this.uploadedChunks.push(chunk.index);
                this.calculateTotalProgress();
                
                // 存储已上传的分片信息到本地存储
                this.saveUploadState();
                
                this.currentChunkIndex++;
                this.uploadNextChunk();
              } else {
                chunk.status = 'failed';
                this.uploadStatus = `分片 ${chunk.index + 1} 上传失败: ${response.message}`;
              }
            } catch (e) {
              console.error('解析响应失败:', e, xhr.responseText);
              chunk.status = 'failed';
              this.uploadStatus = `分片 ${chunk.index + 1} 上传失败: 解析响应失败`;
            }
          } else {
            console.error('上传状态错误:', xhr.status, xhr.statusText);
            chunk.status = 'failed';
            this.uploadStatus = `分片 ${chunk.index + 1} 上传失败: ${xhr.status} ${xhr.statusText}`;
          }
        };
        
        xhr.onerror = () => {
          console.error('上传网络错误');
          chunk.status = 'failed';
          this.uploadStatus = `分片 ${chunk.index + 1} 上传失败: 网络错误`;
        };
        
        xhr.onabort = () => {
          console.log('上传已中止');
          chunk.status = 'paused';
          this.uploadStatus = `分片 ${chunk.index + 1} 上传已暂停`;
        };
        
        xhr.open('POST', '/api/upload/chunk');
        xhr.send(formData);
        
        // 保存xhr引用以便能够中止上传
        chunk.xhr = xhr;
      } catch (error) {
        console.error('上传分片出错:', error);
        chunk.status = 'failed';
        this.uploadStatus = `分片 ${chunk.index + 1} 上传失败: ${error.message}`;
      }
    },
    calculateTotalProgress() {
      // 如果没有分片，进度为0
      if (this.chunks.length === 0) {
        this.uploadProgress = 0;
        return;
      }
      
      // 计算已完成的分片数量
      const completedChunks = this.chunks.filter(chunk => chunk.status === 'completed').length;
      // 计算当前正在上传的分片的进度
      const currentChunk = this.chunks[this.currentChunkIndex];
      const currentProgress = (currentChunk && currentChunk.status === 'uploading') ? currentChunk.progress : 0;
      
      // 总进度 = (已完成分片 + 当前分片进度比例) / 总分片数
      this.uploadProgress = ((completedChunks + (currentProgress / 100)) / this.chunks.length) * 100;
      
      // 确保进度值在有效范围内
      this.uploadProgress = Math.min(100, Math.max(0, this.uploadProgress));
      
      console.log('进度更新:', {
        completedChunks,
        totalChunks: this.chunks.length,
        currentChunkIndex: this.currentChunkIndex,
        currentProgress,
        totalProgress: this.uploadProgress
      });
    },
    async mergeChunks() {
      try {
        this.uploadStatus = '所有分片上传完成，正在合并文件...';
        console.log('准备合并文件:', {
          uploadId: this.uploadId,
          fileName: this.selectedFile.name,
          totalChunks: this.chunks.length,
          uploadedChunks: this.uploadedChunks.length
        });
        
        const response = await fetch('/api/upload/complete', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            uploadId: this.uploadId,
            fileName: this.selectedFile.name,
            totalChunks: this.chunks.length
          })
        });
        
        // 解析响应
        let result;
        try {
          result = await response.json();
        } catch (e) {
          console.error('解析合并响应失败:', e);
          throw new Error('解析服务器响应失败');
        }
        
        if (!response.ok) {
          console.error('合并文件请求失败:', response.status, result);
          throw new Error(result.message || `合并文件失败: HTTP ${response.status}`);
        }
        
        if (result.code !== 0) {
          console.error('合并文件业务失败:', result);
          throw new Error(result.message || '合并文件失败');
        }
        
        console.log('文件合并成功:', result);
        this.uploadStatus = '文件上传成功！';
        this.isUploading = false;
        this.uploadId = null;
        
        // 清除本地存储的上传状态
        localStorage.removeItem(`upload_state_${this.selectedFile.name}`);
      } catch (error) {
        console.error('合并文件出错:', error);
        this.uploadStatus = `合并文件失败: ${error.message}`;
        throw error;
      }
    },
    pauseUpload() {
      this.isPaused = true;
      this.uploadStatus = '上传已暂停';
      
      // 中止当前正在上传的请求
      const currentChunk = this.chunks[this.currentChunkIndex];
      if (currentChunk && currentChunk.xhr) {
        currentChunk.xhr.abort();
        currentChunk.status = 'paused';
      }
      
      // 保存上传状态
      this.saveUploadState();
    },
    resumeUpload() {
      if (!this.isPaused) return;
      
      this.isPaused = false;
      this.uploadStatus = '继续上传中...';
      this.uploadNextChunk();
    },
    cancelUpload() {
      this.isUploading = false;
      this.isPaused = false;
      this.uploadProgress = 0;
      this.currentChunkIndex = 0;
      this.uploadStatus = '上传已取消';
      
      // 中止当前正在上传的请求
      const currentChunk = this.chunks[this.currentChunkIndex];
      if (currentChunk && currentChunk.xhr) {
        currentChunk.xhr.abort();
      }
      
      // 清除本地存储的上传状态
      localStorage.removeItem(`upload_state_${this.selectedFile.name}`);
    },
    saveUploadState() {
      if (!this.selectedFile) return;
      
      const state = {
        uploadId: this.uploadId,
        fileName: this.selectedFile.name,
        fileSize: this.selectedFile.size,
        chunkSize: this.chunkSize,
        uploadedChunks: this.uploadedChunks,
        chunksHash: this.chunks.map(chunk => chunk.hash),
        timestamp: Date.now()
      };
      
      localStorage.setItem(`upload_state_${this.selectedFile.name}`, JSON.stringify(state));
    },
    loadUploadState() {
      if (!this.selectedFile) return false;
      
      const stateJson = localStorage.getItem(`upload_state_${this.selectedFile.name}`);
      if (!stateJson) return false;
      
      try {
        const state = JSON.parse(stateJson);
        
        // 验证状态是否有效
        if (
          state.fileName === this.selectedFile.name &&
          state.fileSize === this.selectedFile.size &&
          state.chunkSize === this.chunkSize &&
          state.uploadedChunks &&
          Array.isArray(state.uploadedChunks)
        ) {
          this.uploadId = state.uploadId;
          this.uploadedChunks = state.uploadedChunks;
          
          // 加载哈希值
          if (state.chunksHash && state.chunksHash.length === this.chunks.length) {
            this.chunks.forEach((chunk, index) => {
              chunk.hash = state.chunksHash[index];
            });
          }
          
          // 标记已上传的块
          this.uploadedChunks.forEach(chunkIndex => {
            if (this.chunks[chunkIndex]) {
              this.chunks[chunkIndex].status = 'completed';
              this.chunks[chunkIndex].progress = 100;
            }
          });
          
          // 找到下一个未上传的块索引
          this.currentChunkIndex = 0;
          while (
            this.currentChunkIndex < this.chunks.length && 
            this.chunks[this.currentChunkIndex].status === 'completed'
          ) {
            this.currentChunkIndex++;
          }
          
          this.calculateTotalProgress();
          
          this.uploadStatus = `已恢复上传状态，已上传 ${this.uploadedChunks.length} 个分片`;
          return true;
        }
      } catch (error) {
        console.error('解析上传状态出错:', error);
      }
      
      return false;
    },
    formatFileSize(bytes) {
      if (bytes === 0) return '0 Bytes';
      
      const k = 1024;
      const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      
      return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }
  },
  mounted() {
    // 当窗口关闭时保存上传状态
    window.addEventListener('beforeunload', this.saveUploadState);
  },
  beforeDestroy() {
    window.removeEventListener('beforeunload', this.saveUploadState);
  }
}
</script>

<style lang="less" scoped>
.container {
  max-width: 800px;
  margin: 0 auto;
  padding: 20px;
  font-family: Arial, sans-serif;
  
  h1 {
    text-align: center;
    margin-bottom: 30px;
  }
  
  .upload-container {
    border: 2px dashed #ccc;
    border-radius: 8px;
    padding: 20px;
    
    .file-selection {
      display: flex;
      justify-content: center;
      margin-bottom: 20px;
      
      input[type="file"] {
        display: none;
      }
      
      button {
        background-color: #4CAF50;
        color: white;
        padding: 10px 20px;
        border: none;
        border-radius: 4px;
        cursor: pointer;
        font-size: 16px;
        
        &:hover {
          background-color: #45a049;
        }
      }
    }
    
    .upload-info {
      margin-bottom: 20px;
      
      p {
        margin: 5px 0;
      }
    }
    
    .progress-container {
      width: 100%;
      height: 30px;
      background-color: #f3f3f3;
      border-radius: 4px;
      margin: 15px 0;
      position: relative;
      overflow: hidden;
      
      .progress-bar {
        position: absolute;
        left: 0;
        top: 0;
        height: 100%;
        background-color: #4CAF50;
        transition: width 0.5s;
        min-width: 0%;
      }
      
      span {
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        color: #333;
        font-weight: bold;
        z-index: 1;
      }
    }
    
    .upload-controls {
      display: flex;
      justify-content: center;
      gap: 10px;
      flex-wrap: wrap;
      
      button {
        padding: 8px 15px;
        border: none;
        border-radius: 4px;
        cursor: pointer;
        font-size: 14px;
        
        &:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        
        &:nth-child(1) {
          background-color: #4CAF50;
          color: white;
          
          &:hover:not(:disabled) {
            background-color: #45a049;
          }
        }
        
        &:nth-child(2) {
          background-color: #ff9800;
          color: white;
          
          &:hover:not(:disabled) {
            background-color: #e68a00;
          }
        }
        
        &:nth-child(3) {
          background-color: #2196F3;
          color: white;
          
          &:hover:not(:disabled) {
            background-color: #0b7dda;
          }
        }
        
        &:nth-child(4) {
          background-color: #f44336;
          color: white;
          
          &:hover:not(:disabled) {
            background-color: #da190b;
          }
        }
      }
    }
    
    .upload-status {
      margin-top: 20px;
      padding: 10px;
      background-color: #f9f9f9;
      border-radius: 4px;
      text-align: center;
      
      p {
        margin: 0;
        font-weight: bold;
      }
    }
  }
}
</style>