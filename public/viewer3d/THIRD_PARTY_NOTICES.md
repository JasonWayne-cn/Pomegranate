# 三维查看器第三方组件声明

`o3dv.min.js` 来自 **Online 3D Viewer 0.18.0**（MIT），打包时通过 esbuild 合并了以下依赖：

| 组件 | 版本 | 许可证 | 项目地址 |
| --- | --- | --- | --- |
| Online 3D Viewer | 0.18.0 | MIT | https://github.com/kovacsv/Online3DViewer |
| three.js | 0.176.0 | MIT | https://github.com/mrdoob/three.js |
| fflate | 0.8.2 | MIT | https://github.com/101arrowz/fflate |

## MIT License

Copyright (c) 2023 Viktor Kovacs
Copyright (c) 2010-2024 three.js authors
Copyright (c) 2021 Arjun Barrett

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

> 说明：STEP / IGES / BREP / 3DM / IFC 等 CAD 格式需要 Online 3D Viewer 的
> 外部解码器（OCCT / rhino3dm / web-ifc），当前内置版本未包含，后续通过扩展包提供。
