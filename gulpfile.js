var gulp   = require('gulp');
var concat = require('gulp-concat');
var server = require('gulp-devserver');
var uglify = require('gulp-uglify');
var rename = require('gulp-rename');
var watch  = require('gulp-watch');

gulp.task('build', function() {
  // css
  gulp.src([
      './src/video-js.css',
      './src/videojs-resolution-switcher.css',
      './src/videojs.autoplay-toggle.css',
      './src/videojs.errors.css'
    ])
    .pipe(concat('hls.css'))
    .pipe(gulp.dest('./dist/'));

  // WebWorker
  gulp.src([
      './src/transmuxer_worker.js'
    ])
    .pipe(concat('transmuxer_worker.js'))
    .pipe(gulp.dest('./dist/'));

  // 视频处理器
  gulp.src([
    './src/mux.js/utils/stream.js',
    './src/mux.js/utils/exp-golomb.js',
    './src/mux.js/codecs/aac.js',
    './src/mux.js/codecs/h264.js',
    './src/mux.js/flv/flv-tag.js',
    './src/mux.js/flv/transmuxer.js',
    './src/mux.js/m2ts/caption-stream.js',
    './src/mux.js/m2ts/m2ts.js',
    './src/mux.js/m2ts/metadata-stream.js',
    './src/mux.js/mp4/mp4-generator.js',
    './src/mux.js/mp4/transmuxer.js',
    './src/mux.js/tools/flv-inspector.js',
    './src/mux.js/tools/mp4-inspector.js'
  ])
  .pipe(concat('mux.js'))
  .pipe(gulp.dest('./dist/'));

  // video.js
  gulp.src([
    './src/videojs-ie8.js',
    './src/video.js',
    './src/videojs-resolution-switcher.js',
    './src/videojs.persistvolume.js',
    './src/videojs.autoplay-toggle.js',
    './src/videojs.watermark.js',
    './src/videojs.errors.js',
    './src/videojs.hotkeys.js',
    './src/videojs.monitor.js',
    './src/hls.js'
  ])
  .pipe(concat('video.js'))
  .pipe(gulp.dest('./dist/'));

  // videojs.hls.js
  gulp.src([
      './src/hls/videojs-hls.js',
      './src/hls/xhr.js',
      './src/hls/stream.js',
      './src/hls/m3u8/m3u8-parser.js',
      './src/hls/playlist.js',
      './src/hls/playlist-loader.js',
      './src/hls/pkcs7.unpad.js',
      './src/hls/decrypter.js',
      './src/hls/bin-utils.js'
    ])
    .pipe(concat('videojs.hls.js'))
    .pipe(gulp.dest('./src/'));

  gulp.src([
      './src/videojs-contrib-media-sources.js',
      './src/videojs.hls.js'
    ])
    .pipe(concat('hls.js'))
    .pipe(gulp.dest('./dist/'));

  gulp.src(['./src/video-js-bsie.swf'])
    .pipe(gulp.dest('./dist/'));

  // gulp.src('./dist/hls.js')
  //   .pipe(uglify())
  //   .pipe(rename('hls.min.js'))
  //   .pipe(gulp.dest('./dist/'));
});

gulp.task('server', function () {
  gulp.src('./')
    .pipe(server());
});
