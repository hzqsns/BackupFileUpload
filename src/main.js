import Vue from 'vue'
import App from './App.vue'
import './style.css'

// 全局错误处理
Vue.config.errorHandler = function (err, vm, info) {
  console.error('Vue错误:', err, info)
}

new Vue({
  render: h => h(App)
}).$mount('#app')

