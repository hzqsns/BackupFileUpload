const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

// 增加超时限制，处理大文件上传可能需要更长时间
app.timeout = 1800000; // 30分钟超时

// 中间件配置
app.use(cors());
app.use(express.json({ limit: '10mb' })); // 增加请求体大小限制
app.use(express.static('dist'));

// 启用请求日志
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
  next();
});

// 存储上传文件的目录
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const TEMP_DIR = path.join(__dirname, 'temp');

// 确保上传目录存在
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// 存储上传状态
const uploadTasks = new Map();

// 存储文件哈希信息，用于秒传功能
const fileHashMap = new Map();

// 配置multer存储
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    console.log('Multer destination:', { body: req.body });
    
    // 由于是通过手动处理，这里可能req.body还没有被解析
    // 使用一个临时目录先
    const tempDir = path.join(TEMP_DIR, 'pending');
    
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    
    cb(null, tempDir);
  },
  filename: function (req, file, cb) {
    console.log('Multer filename:', { body: req.body, file });
    // 生成一个临时文件名
    cb(null, `temp-${Date.now()}-${file.originalname}`);
  }
});

// 文件大小限制为10GB
const upload = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024 * 1024 // 10GB
  }
});

// 初始化上传任务
app.post('/api/upload/init', (req, res) => {
  try {
    console.log('收到初始化上传请求:', req.body);
    
    const { fileName, fileSize, chunkSize, chunkCount, chunksInfo } = req.body;
    
    // 如果提供了分片哈希信息，检查是否可以秒传
    if (chunksInfo && chunksInfo.length > 0) {
      // 计算整个文件的指纹
      const fileHash = chunksInfo.map(chunk => chunk.hash).join('_');
      console.log('计算的文件指纹:', fileHash);
      
      // 检查是否存在相同文件（秒传）
      if (fileHashMap.has(fileHash)) {
        const existingFile = fileHashMap.get(fileHash);
        
        // 检查文件是否实际存在
        const filePath = path.join(UPLOAD_DIR, existingFile.fileName);
        if (fs.existsSync(filePath)) {
          console.log('文件已存在，启用秒传功能:', existingFile.fileName);
          
          // 创建一个新的上传ID，但标记为秒传
          const uploadId = uuidv4();
          
          res.json({
            code: 0,
            message: '文件已存在，启用秒传',
            data: {
              uploadId,
              shouldSkipUpload: true,
              existingFile: existingFile.fileName
            }
          });
          return;
        }
      }
    }
    
    // 生成唯一的上传ID
    const uploadId = uuidv4();
    const uploadDir = path.join(TEMP_DIR, uploadId);
    
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    
    // 存储上传任务信息
    const taskInfo = {
      uploadId,
      fileName,
      fileSize: Number(fileSize),
      chunkSize: Number(chunkSize),
      chunkCount: Number(chunkCount),
      uploadedChunks: [],
      chunksInfo: chunksInfo || [],
      createdAt: Date.now()
    };
    
    // 如果提供了分片信息，存储每个分片的哈希
    if (chunksInfo && chunksInfo.length > 0) {
      taskInfo.fileHash = chunksInfo.map(chunk => chunk.hash).join('_');
    }
    
    uploadTasks.set(uploadId, taskInfo);
    
    // 获取此文件是否有之前上传的分片
    const uploadedChunks = [];
    
    // 检查是否有已上传的分片
    if (fs.existsSync(uploadDir)) {
      const files = fs.readdirSync(uploadDir);
      files.forEach(file => {
        if (file.startsWith('chunk-')) {
          const chunkIndex = parseInt(file.split('-')[1]);
          uploadedChunks.push(chunkIndex);
          taskInfo.uploadedChunks.push(chunkIndex);
        }
      });
    }
    
    console.log('上传初始化成功:', {
      uploadId, 
      fileName, 
      chunkCount,
      uploadedChunks: uploadedChunks.length,
      hasChunksInfo: chunksInfo && chunksInfo.length > 0
    });
    
    res.json({
      code: 0,
      message: '上传初始化成功',
      data: {
        uploadId,
        uploadedChunks
      }
    });
  } catch (error) {
    console.error('上传初始化错误:', error);
    res.status(500).json({
      code: 500,
      message: '上传初始化失败',
      error: error.message
    });
  }
});

// 上传分片
app.post('/api/upload/chunk', (req, res) => {
  console.log('收到分片上传请求的headers:', req.headers);
  
  try {
    // 使用单个上传处理
    upload.single('file')(req, res, function(err) {
      if (err) {
        console.error('Multer错误:', err);
        return res.status(500).json({
          code: 500,
          message: '文件上传处理错误',
          error: err.message
        });
      }
      
      try {
        console.log('文件上传成功，处理req.body:', req.body);
        console.log('上传的文件信息:', req.file);
        
        // 文件应该已经上传成功
        const { uploadId, chunkIndex, chunkHash } = req.body;
        
        console.log('分片上传参数:', { uploadId, chunkIndex, chunkHash });
        
        if (!uploadId || uploadId === 'undefined' || chunkIndex === undefined) {
          return res.status(400).json({
            code: 400,
            message: '缺少必要参数: uploadId和chunkIndex',
            data: { receivedUploadId: uploadId }
          });
        }
        
        const taskInfo = uploadTasks.get(uploadId);
        
        if (!taskInfo) {
          return res.status(404).json({
            code: 404,
            message: '上传任务不存在',
            data: { 
              uploadId,
              availableTasks: Array.from(uploadTasks.keys())
            }
          });
        }
        
        // 验证已上传的文件
        if (!req.file) {
          return res.status(400).json({
            code: 400,
            message: '没有接收到文件'
          });
        }
        
        // 如果提供了分片哈希，对比验证哈希值
        if (chunkHash && taskInfo.chunksInfo && taskInfo.chunksInfo.length > 0) {
          const chunkInfo = taskInfo.chunksInfo.find(c => c.index.toString() === chunkIndex.toString());
          if (chunkInfo && chunkInfo.hash !== chunkHash) {
            console.warn('分片哈希不匹配:', {
              expected: chunkInfo.hash,
              received: chunkHash
            });
            // 注意：这里我们不阻止上传，但可以记录警告
          }
        }
        
        // 将临时文件移动到正确的位置
        const chunkDir = path.join(TEMP_DIR, uploadId);
        if (!fs.existsSync(chunkDir)) {
          fs.mkdirSync(chunkDir, { recursive: true });
        }
        
        const targetPath = path.join(chunkDir, `chunk-${chunkIndex}`);
        fs.renameSync(req.file.path, targetPath);
        
        // 如果提供了分片哈希，保存到文件中
        if (chunkHash) {
          const hashFilePath = path.join(chunkDir, `chunk-${chunkIndex}.hash`);
          fs.writeFileSync(hashFilePath, chunkHash);
        }
        
        // 更新已上传的分片信息
        const chunkIndexNum = Number(chunkIndex);
        if (!taskInfo.uploadedChunks.includes(chunkIndexNum)) {
          taskInfo.uploadedChunks.push(chunkIndexNum);
        }
        
        console.log('分片上传成功: ', {
          chunkIndex: chunkIndexNum,
          uploadedCount: taskInfo.uploadedChunks.length,
          totalCount: taskInfo.chunkCount
        });
        
        res.json({
          code: 0,
          message: '分片上传成功',
          data: {
            uploadedCount: taskInfo.uploadedChunks.length,
            totalCount: taskInfo.chunkCount
          }
        });
      } catch (innerError) {
        console.error('处理上传的分片时出错:', innerError);
        res.status(500).json({
          code: 500,
          message: '处理上传的分片时出错',
          error: innerError.message
        });
      }
    });
  } catch (error) {
    console.error('上传分片出错:', error);
    res.status(500).json({
      code: 500,
      message: '分片上传失败',
      error: error.message
    });
  }
});

// 合并文件
app.post('/api/upload/complete', async (req, res) => {
  try {
    const { uploadId, fileName, totalChunks } = req.body;
    console.log('收到合并文件请求:', { uploadId, fileName, totalChunks });
    
    const taskInfo = uploadTasks.get(uploadId);
    
    if (!taskInfo) {
      console.error('上传任务不存在:', uploadId);
      return res.status(404).json({
        code: 404,
        message: '上传任务不存在'
      });
    }

    console.log('任务信息:', {
      uploadId,
      fileName: taskInfo.fileName,
      fileSize: taskInfo.fileSize,
      uploadedChunks: taskInfo.uploadedChunks.length,
      totalChunks: taskInfo.chunkCount
    });
    
    // 安全的文件名
    const safeFileName = fileName.replace(/[^a-zA-Z0-9_\-\.]/g, '_');
    const uploadDir = path.join(TEMP_DIR, uploadId);
    const filePath = path.join(UPLOAD_DIR, safeFileName);
    
    // 检查所有分片是否都已上传
    if (taskInfo.uploadedChunks.length !== taskInfo.chunkCount) {
      console.error('文件分片不完整:', {
        uploaded: taskInfo.uploadedChunks.length,
        required: taskInfo.chunkCount,
        missing: getMissingChunks(taskInfo.uploadedChunks, taskInfo.chunkCount)
      });
      
      return res.status(400).json({
        code: 400,
        message: '文件分片不完整，无法合并',
        data: {
          uploaded: taskInfo.uploadedChunks.length,
          total: taskInfo.chunkCount,
          missing: getMissingChunks(taskInfo.uploadedChunks, taskInfo.chunkCount)
        }
      });
    }
    
    // 检查所有分片文件是否存在
    const missingFiles = [];
    for (let i = 0; i < taskInfo.chunkCount; i++) {
      const chunkPath = path.join(uploadDir, `chunk-${i}`);
      if (!fs.existsSync(chunkPath)) {
        missingFiles.push(i);
      }
    }
    
    if (missingFiles.length > 0) {
      console.error('有分片文件丢失:', missingFiles);
      return res.status(400).json({
        code: 400,
        message: '部分分片文件丢失，无法合并',
        data: { missingFiles }
      });
    }
    
    console.log('开始合并文件到:', filePath);
    
    try {
      // 使用流式合并，避免一次性读取全部文件到内存
      await mergeChunksWithStream(uploadDir, filePath, taskInfo.chunkCount);
      
      // 检查合并后的文件大小是否正确
      const stats = fs.statSync(filePath);
      console.log('文件合并完成，大小:', stats.size);
      
      if (stats.size !== taskInfo.fileSize) {
        console.warn('合并后的文件大小与原始文件大小不一致:', {
          expected: taskInfo.fileSize,
          actual: stats.size,
          difference: taskInfo.fileSize - stats.size
        });
      }
      
      // 如果有文件哈希，存储到哈希映射中用于后续秒传
      if (taskInfo.fileHash) {
        fileHashMap.set(taskInfo.fileHash, {
          fileName: safeFileName,
          fileSize: stats.size,
          uploadTime: Date.now()
        });
        console.log('已存储文件哈希用于秒传:', taskInfo.fileHash);
      }
      
      // 清理临时分片
      console.log('清理临时目录:', uploadDir);
      fs.rmdirSync(uploadDir, { recursive: true });
      
      // 删除任务信息
      uploadTasks.delete(uploadId);
      
      res.json({
        code: 0,
        message: '文件合并成功',
        data: {
          fileName: safeFileName,
          fileSize: stats.size,
          filePath: `/uploads/${safeFileName}`
        }
      });
    } catch (mergeError) {
      console.error('合并文件过程中出错:', mergeError);
      return res.status(500).json({
        code: 500,
        message: `合并文件失败: ${mergeError.message}`,
        error: mergeError.message
      });
    }
  } catch (error) {
    console.error('文件合并请求处理出错:', error);
    res.status(500).json({
      code: 500,
      message: '文件合并失败',
      error: error.message
    });
  }
});

// 辅助函数：获取缺失的分片索引
function getMissingChunks(uploadedChunks, totalChunks) {
  const missing = [];
  for (let i = 0; i < totalChunks; i++) {
    if (!uploadedChunks.includes(i)) {
      missing.push(i);
    }
  }
  return missing;
}

// 辅助函数：使用流式合并文件，减少内存使用
async function mergeChunksWithStream(sourceDir, targetPath, totalChunks) {
  // 确保目标目录存在
  const targetDir = path.dirname(targetPath);
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }
  
  // 创建写入流
  const writeStream = fs.createWriteStream(targetPath);
  
  try {
    for (let i = 0; i < totalChunks; i++) {
      const chunkPath = path.join(sourceDir, `chunk-${i}`);
      
      // 检查文件是否存在
      if (!fs.existsSync(chunkPath)) {
        throw new Error(`分片 ${i} 文件不存在: ${chunkPath}`);
      }
      
      // 逐个分片流式写入
      await new Promise((resolve, reject) => {
        const readStream = fs.createReadStream(chunkPath);
        
        readStream.on('error', (err) => {
          console.error(`读取分片 ${i} 出错:`, err);
          reject(new Error(`读取分片 ${i} 失败: ${err.message}`));
        });
        
        writeStream.on('error', (err) => {
          console.error(`写入分片 ${i} 到目标文件出错:`, err);
          reject(new Error(`写入分片 ${i} 失败: ${err.message}`));
        });
        
        readStream.pipe(writeStream, { end: false });
        readStream.on('end', () => {
          console.log(`分片 ${i + 1}/${totalChunks} 合并完成`);
          resolve();
        });
      });
    }
    
    // 关闭写入流
    await new Promise((resolve, reject) => {
      writeStream.end();
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
    });
    
    console.log('所有分片合并完成');
  } catch (error) {
    // 确保写入流关闭
    writeStream.end();
    
    // 如果发生错误，删除已部分合并的文件
    if (fs.existsSync(targetPath)) {
      fs.unlinkSync(targetPath);
    }
    
    throw error;
  }
}

// 获取上传状态
app.get('/api/upload/status/:uploadId', (req, res) => {
  const { uploadId } = req.params;
  const taskInfo = uploadTasks.get(uploadId);
  
  if (!taskInfo) {
    return res.status(404).json({
      code: 404,
      message: '上传任务不存在'
    });
  }
  
  res.json({
    code: 0,
    message: '获取上传状态成功',
    data: {
      uploadId,
      fileName: taskInfo.fileName,
      fileSize: taskInfo.fileSize,
      chunkSize: taskInfo.chunkSize,
      chunkCount: taskInfo.chunkCount,
      uploadedChunks: taskInfo.uploadedChunks,
      progress: (taskInfo.uploadedChunks.length / taskInfo.chunkCount) * 100
    }
  });
});

// 启动服务器
app.listen(PORT, () => {
  console.log(`服务器已启动，监听端口 ${PORT}`);
  console.log(`上传目录: ${UPLOAD_DIR}`);
  console.log(`临时目录: ${TEMP_DIR}`);
}); 