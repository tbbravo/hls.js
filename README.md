# hls.js
pc hls playback based on video.js

# usage

```
<html>
  <head>
    <link rel="stylesheet" href="/dist/hls.css">
  </head>
  <body>
    <video id="my-video" class="video-js vjs-default-skin" width="640" height="360"></video>

    <script src="./dist/video.js"></script>

    <!--[if (gt IE 9) & (!IE)]>-->
      <script src="./dist/hls.js"></script>
    <!--<![endif]-->
    <script>

        var player = hls('my-video', {
            src: 'http://xxx.m3u8'
        });
    </script>
  </body>
</html>
```

## step
1. build
```
npm install
gulp build
```
2. run
```
gulp server
```
3.  watch demo
```
(http://localhost:3000/example.html)[http://localhost:3000/example.html]
```
4. no 4 step :)
