# ar-viewer

Web-based AR product viewer for real-world placement directly in the browser.

---

## Overview

**ar-viewer** enables users to preview 3D objects in their physical environment using WebXR and native device capabilities.

Designed for e-commerce and product demos, it allows seamless transition from 3D preview to real-world AR placement—without requiring app installation.

---

## Features

- Real-time 3D model rendering (GLB/GLTF)
- WebXR-based AR placement (supported devices)
- iOS fallback via native Quick Look (USDZ)
- Mobile-first interaction model
- Lightweight, CDN-friendly asset delivery

---

## Tech Stack

- Three.js
- WebXR API
- GLTF / GLB / USDZ formats
- JavaScript (ES6+)

---

## How It Works

1. Load optimized 3D model (GLB)
2. Render in browser using Three.js
3. Trigger AR session (WebXR)
4. Place object in real-world space
5. Fallback to USDZ on iOS devices

---

## Use Cases

- Furniture visualization
- Home decor preview
- Product showcasing
- Interactive marketing pages

---

## Getting Started

```bash
git clone https://github.com/tezogogaladze/ar-viewer.git
cd ar-viewer
npm install
npm run dev
