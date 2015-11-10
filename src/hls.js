'use strict';

(function (window, document, videojs) {
    window.hls = function (videoId, options, callback) {
      var MSE = !!window.MediaSource; //ie9及其以下版本为true
      var videoType = MSE ? 'application/x-mpegURL' : 'video/mp4';
      var multiResolutions = options.src instanceof Array;

      options.controls = options.controls || true;

      if (!MSE) {
          videojs.options.flash.swf = "./src/video-js-bsie.swf";
          options["techOrder"] = ["flash"];
      }

      // multiResolutions && (delete options.src);

      var player = videojs(videoId, options, callback);

      videojs.addLanguage('zh-CN', {
        "Play": "播放",
        "Pause": "暂停",
        "Current Time": "当前时间",
        "Duration Time": "时长",
        "Remaining Time": "剩余时间",
        "Stream Type": "媒体流类型",
        "LIVE": "直播",
        "Loaded": "加载完毕",
        "Progress": "进度",
        "Fullscreen": "全屏",
        "Non-Fullscreen": "退出全屏",
        "Mute": "静音",
        "Unmuted": "取消静音",
        "Playback Rate": "播放码率",
        "Subtitles": "字幕",
        "subtitles off": "字幕关闭",
        "Captions": "内嵌字幕",
        "captions off": "内嵌字幕关闭",
        "Chapters": "节目段落",
        "You aborted the media playback": "视频播放被终止",
        "A network error caused the media download to fail part-way.": "网络错误导致视频下载中途失败。",
        "The media could not be loaded, either because the server or network failed or because the format is not supported.": "视频因格式不支持或者服务器或网络的问题无法加载。",
        "The media playback was aborted due to a corruption problem or because the media used features your browser did not support.": "由于视频文件损坏或是该视频使用了你的浏览器不支持的功能，播放终止。",
        "No compatible source was found for this media.": "无法找到此视频兼容的源。",
        "The media is encrypted and we do not have the keys to decrypt it.": "视频已加密，无法解密。"
      });

      player.autoplayToggle({namespace: 'videojs-autoplay'});
      
      // player.watermark({
      //     file: 'http://tb2.bdstatic.com/tb/static-common/img/search_logo_big_282cef2.gif',
      //     xpos: 100,
      //     ypos: 0,
      //     xrepeat: 0,
      //     opacity: 0.5,
      //     className: 'vjs-watermark'
      // });

      if (MSE) {
          player.monitor();
      }

      if (MSE && multiResolutions) {
          player.videoJsResolutionSwitcher({
            'default': 'high'
          });

          for(var i=0, len = options.src.length; i < len; i++) {
              options.src[i].type = videoType;
          }

          player.updateSrc(options.src);

          $('.vjs-resolution-button').on('click', function () {
              $('.vjs-resolution-button .vjs-menu').removeClass('.vjs-lock-showing').toggle();
              $('.vjs-resolution-button-staticlabel').toggleClass('active');
          });
      }

      player.errors();

      player.hotkeys();

      $('.video-js').on('mouseleave', function () {
          if ($('.vjs-resolution-button .vjs-menu').is(':hidden')) {
              player.userActive(false);
          }
      });

      player.on('userinactive', function () {
          $('.vjs-resolution-button .vjs-menu').hide();
      });

      $('.vjs-live-display').on('click', function () {
        player.src({
          src: player.getCache().src,
          type: videoType
        });

        if (MSE) {
          player.play();
        } else {
          setTimeout(function () {
            player.play();
          }, 1000);
        }
      });

      player.on('error', function (e) {

        console.log(e);
        console.log(player.getCache().src);
        

          // player.src({
          //   src: player.getCache().src,
          //   type: videoType
          // });

          // if (MSE) {
          //   player.play();
          // } else {
          //   setTimeout(function () {
          //     player.play();
          //   }, 1000);
          // }
      });

      return player;
  }
})(window, document, videojs);
