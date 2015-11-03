var gulp   = require('gulp');
var concat = require('gulp-concat');
var server = require('gulp-devserver');
var uglify = require('gulp-uglify');
var rename = require('gulp-rename');
var watch  = require('gulp-watch');

gulp.task('build', function() {
  gulp.src([
      './src/video-js.css',
      './src/videojs-resolution-switcher.css',
      './src/videojs.autoplay-toggle.css',
      './src/videojs.errors.css'
    ])
    .pipe(concat('hls.css'))
    .pipe(gulp.dest('./dist/'));

  gulp.src([
    './src/videojs-ie8.js',
    './src/video.js',
    './src/videojs-resolution-switcher.js',
    './src/videojs.persistvolume.js',
    './src/videojs.autoplay-toggle.js',
    './src/videojs.watermark.js',
    './src/videojs.errors.js',
    './src/videojs.hotkeys.js',
    './src/videojs.monitor.js'
  ])
  .pipe(concat('video.js'))
  .pipe(gulp.dest('./dist/'));

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

  // gulp.src('./dist/hls.js')
  //   .pipe(uglify())
  //   .pipe(rename('hls.min.js'))
  //   .pipe(gulp.dest('./dist/'));
});

gulp.task('server', function () {
  gulp.src('./')
    .pipe(server());
});
