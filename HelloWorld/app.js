"use strict";

// https://en.wikipedia.org/wiki/Web_Mercator
// http://mike.teczno.com/notes/osm-us-terrain-layer/foreground.html
// https://www.mapbox.com/blog/3d-terrain-threejs/
// bugbug feature detect webgl, fetch, web workers
// bugbug http://www.thunderforest.com/maps/landscape/
// TODO http://wiki.openstreetmap.org/wiki/Zoom_levels Set correct zoom level on navigate
// TODO Add location to URL
// TODO Allow HMD rotate

document.addEventListener("DOMContentLoaded", init);

let WindowIsActive = true;
window.addEventListener('focus', () => { WindowIsActive = true })
window.addEventListener('blur', () => { WindowIsActive = false })

let user = new THREE.Vector3(331.02, 1.55, 722.992);	// the point on the map we are currently above

const tileDimension = 256;	// Tiles are 256 x 256 pixels
let terrainTiles;	  		// Tiles.js instance for elevation data
let mapTiles;		 		// Tiles.js instance for color values

const mapZoom = 11; // The zoom level of the slippy map we're using
const terrainZoom = 11;

function checkKey(e) {

	const step = 0.05;

	let vector = new THREE.Vector3(0, 0, 0);

	e = e || window.event;
	if (e.keyCode == '38') {
		// up arrow
		vector.z = -step;
		e.stopPropagation();
	}
	else if (e.keyCode == '40') {
		// down arrow		     	
		vector.z = step;
		e.stopPropagation();
	}
	else if (e.keyCode == '37') {
		// left arrow
		vector.x = -step;
		e.stopPropagation();

	}
	else if (e.keyCode == '39') {
		// right arrow	
		vector.x = step;
		e.stopPropagation();
	}

	else if (e.keyCode == '219') {
		// [
		user.y -= step;
		e.stopPropagation();
	}
	else if (e.keyCode == '221') {
		// ]
		user.y += step;
		e.stopPropagation();
	}

	vector.applyQuaternion(camera.quaternion);

	user.x += vector.x;
	user.z += vector.z;

}

/// three js
let scene, camera, renderer;
let controls;
let orbitControls;
let effect; // the webvr renderer
let geometry, material, mesh;

let terrainTexture;
let mapTexture;

let laserPointer;  // the cursor / pointer we're drawing for the gamepad

function long2tile(lon, zoom) { return (Math.floor((lon + 180) / 360 * Math.pow(2, zoom))); }
function lat2tile(lat, zoom) {
	let f = Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180);
	return (Math.floor((1 - Math.log(f) / Math.PI) / 2 * Math.pow(2, zoom)));
}

function tile2long(x, z) { return (x / Math.pow(2, z) * 360 - 180); }
function tile2lat(y, z) { let n = Math.PI - 2 * Math.PI * y / Math.pow(2, z); return (180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)))); }

function isMobile() {
	return (navigator.userAgent.toLowerCase().indexOf('mob') != -1);
}

let moving = false;
let downTime = 0;
function orbitMouseDown() {
	moving = true;
	downTime = window.performance.now();
}

function orbitMouseUp() {
	downTime = 0;
	moving = false;
}

// TODO move all desktop/mobile complexity const to a struct

let canvasComplexity;

function initGraphics() {

	// Set up maps

	scene = new THREE.Scene();

	renderer = new THREE.WebGLRenderer({ canvas: document.getElementById('vrCanvas'), preserveDrawingBuffer: true }); //bugbug this might kill mobile perf?
	renderer.setClearColor(0x87ceff, 1);

	effect = new THREE.VREffect(renderer);

	//redundant renderer.setSize(document.body.clientWidth, document.body.clientHeight);
	renderer.setPixelRatio(window.devicePixelRatio);

	camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 100);
	camera.lookAt(new THREE.Vector3(0, -0.5, -1));

	{
		let pointerGeometry = new THREE.CylinderGeometry(0.01, 0.01, 100, 4); //bugbug top and bottom are swapped?
		pointerGeometry.rotateX(0.25 * 2 * Math.PI);
		let pointerMaterial = new THREE.MeshBasicMaterial({ color: 0xff0000 });
		laserPointer = new THREE.Mesh(pointerGeometry, pointerMaterial);
	}
	scene.add(laserPointer);

	let meshComplexity = isMobile() ? 128 : 1024;
	canvasComplexity = isMobile() ? 2048 : 8192;
	let mapSize = 10;

	geometry = new THREE.PlaneGeometry(mapSize, mapSize, meshComplexity, meshComplexity);

	terrainTiles = new Tiles('https://tile.mapzen.com/mapzen/terrain/v1/terrarium/%zoom%/%x%/%y%.png?api_key=mapzen-JcyHAc8', canvasComplexity, terrainZoom);
	mapTiles = new Tiles('https://b.tiles.mapbox.com/v4/mapbox.satellite/%zoom%/%x%/%y%.pngraw?access_token=pk.eyJ1IjoiZnJhbmtvbGl2aWVyIiwiYSI6ImNqMHR3MGF1NTA0Z24ycW81dXR0dDIweDMifQ.SoQ9aqIfdOheISIYRqgR7w', canvasComplexity, mapZoom);

	const gl = renderer.context;

	let vertexShader = 
	    "varying vec2 vUV; " +
		"uniform sampler2D terrainTexture;" +
		"uniform vec2 terrainTextureOffset; " +
	    "varying float vDistance; " +
		"void main() { " +
		"vUV = vec2(uv.x, 1.0 - uv.y); vec4 q = texture2D(terrainTexture, vUV + terrainTextureOffset) * 256.0; " +
		"float elevation = q.r * 256.0 + q.g + q.b / 256.0 - 32768.0; " +
		"elevation = clamp(elevation, 0.0, 10000.0); " +					// Clamp to sea level and Everest
		"elevation = elevation / 28000.0; " +   							// TODO change this based on latitude 
		"vec3 p = position;" + 												// 'position' is a built-in three.js construct
		"p.z += elevation; " +
		"gl_Position = projectionMatrix * modelViewMatrix * vec4(p.x, p.y, p.z, 1.0 ); " +
		"vDistance = distance(gl_Position.xyz, vec3(0.0, 0.0, 0.0));" +
		"}";

	let fragmentShader = 
	    "varying vec2 vUV; " +
		"uniform sampler2D mapTexture; " +
		"uniform vec2 mapTextureOffset; " +
		"varying float hazeStrength; " +
		"varying float vDistance;" +
		"void main() { " +
		"  gl_FragColor = texture2D(mapTexture, vUV + mapTextureOffset); " +
		"  float hazeStrength = smoothstep(" + mapSize * 0.307 + ", " +  + mapSize * 0.499 + ", vDistance);" +
		//" hazeStrength = 0.0; " +
		"  gl_FragColor = mix(gl_FragColor, vec4(135.0 / 256.0, 206.0 / 256.0, 1.0, 1.0), hazeStrength); " +
		"}";

	
	terrainTexture = new UpdatableTexture();
	terrainTexture.setRenderer( renderer );
	terrainTexture.minFilter = terrainTexture.magFilter = THREE.NearestFilter;
	terrainTexture.wrapS = terrainTexture.wrapT = THREE.RepeatWrapping;
	terrainTexture.anisotropy = 1;
	terrainTexture.generateMipmaps = false;
	
	mapTexture = new UpdatableTexture();
	mapTexture.setRenderer( renderer );
	mapTexture.minFilter = THREE.LinearMipMapLinearFilter;
	mapTexture.magFilter = THREE.LinearFilter;
	mapTexture.wrapS = mapTexture.wrapT = THREE.RepeatWrapping;
	mapTexture.generateMipmaps = true;
	terrainTexture.anisotropy = 1; //renderer.getMaxAnisotropy();

	mapTexture.flipY = false;



	material = new THREE.ShaderMaterial({
		uniforms: {
			terrainTexture: { type: 't', value: terrainTexture },
			terrainTextureOffset: { value: new THREE.Vector2() },
			mapTexture: { type: 't', value: mapTexture },
			mapTextureOffset: { value: new THREE.Vector2() }
		},
		vertexShader: vertexShader,
		fragmentShader: fragmentShader
	});

	mesh = new THREE.Mesh(geometry, material);

	mesh.lookAt(new THREE.Vector3(0, 1, 0));

	scene.add(mesh);

	controls = new THREE.VRControls(camera);
	controls.standing = false;

	// non-VR controls
	orbitControls = new THREE.OrbitControls(camera, renderer.domElement);
	orbitControls.maxPolarAngle = Math.PI * 0.7;
	orbitControls.minDistance = 1.2;
	orbitControls.maxDistance = 2.4;
	orbitControls.enableKeys = false;

	renderer.domElement.addEventListener("mousedown", orbitMouseDown);
	renderer.domElement.addEventListener("mouseup", orbitMouseUp);
	renderer.domElement.addEventListener("mouseout", orbitMouseUp);
	renderer.domElement.addEventListener("touchstart", orbitMouseDown);
	renderer.domElement.addEventListener("touchend", orbitMouseUp);

	document.getElementById('vrButton').onclick = function () {
		effect.isPresenting ? effect.exitPresent() : effect.requestPresent();
	};

	// Set up uniforms
	//fMapTextureUniform = gl.getUniformLocation(this.pictureprogram, "terrainTexture");

	// Set the texture to use
	//gl.uniform1i(fMapTextureUniform, 1);

	effect.render(scene, camera); // Need to call this at least once to init texture system

	terrainTexture.setSize( canvasComplexity, canvasComplexity );
	mapTexture.setSize( canvasComplexity, canvasComplexity );

	window.addEventListener("resize", onWindowResize);
	onWindowResize();

}

function handleController() {
	// Handle controller input

	let hasPointerHardware = false;

	try {

		let gamepads = navigator.getGamepads();

		for (let i = 0; i < gamepads.length; ++i) {
			let controller = gamepads[i];

			if (controller != null) {

				if (controller.pose.hasPosition == true) {
					try {
						laserPointer.position.x = controller.pose.position[0];
						laserPointer.position.y = controller.pose.position[1];
						laserPointer.position.z = controller.pose.position[2];
					}
					catch (e) {

					}

				}
				else {
					//laserPointer.position.x = camera.position.x + 0.1; //bugbug
					laserPointer.position.y = camera.position.y - 0.2;
					//laserPointer.position.z = camera.position.z - 0.1;
				}

				let quaternion = new THREE.Quaternion().fromArray(controller.pose.orientation);
				laserPointer.setRotationFromQuaternion(quaternion);

				hasPointerHardware = true;

				let vector = new THREE.Vector3(0, 0, -1);
				vector.applyQuaternion(quaternion);

				let pressed = controller.buttons[0].pressed;

				if (pressed == true) {
					let input = controller.axes[1];

					if (controller.id == "Daydream Controller") {
						input *= -1;	// for some reason the daydream controller values are swapped?
					}

					const scale = 0.01;

					user.x += vector.x * input * scale;
					user.z += vector.z * input * scale;
					user.y += vector.y * input * scale;
				}



			}

		}

	}
	catch (e) {

	}

	laserPointer.visible = hasPointerHardware;

}

function renderScene() {

	effect.requestAnimationFrame(renderScene);

	// Save power and performance by not rendering when window is in the background
	if (!WindowIsActive) return; 

	handleController();

	const fx = user.x;
	const fz = user.z;

	const longtitude = tile2long(fx, mapZoom);
	const latitude = tile2lat(fz, mapZoom);

	terrainTiles.render(longtitude, latitude);
	{
		//smallTerrainCanvas.getContext('2d').drawImage(terrainCanvas, 0, 0, smallTerrainCanvas.width, smallTerrainCanvas.height);
		//let offset = new THREE.Vector2(terrainTiles.getNormalizedOffsetX(), terrainTiles.getNormalizedOffsetY());
		//terrainTexture.transformUv(offset);
		//terrainTexture.offset.x += 0.1;

		material.uniforms.terrainTextureOffset.value.x = terrainTiles.getNormalizedOffsetX();
		material.uniforms.terrainTextureOffset.value.y = terrainTiles.getNormalizedOffsetY();
		material.uniforms.terrainTextureOffset.value.needsUpdate = true;

		///const gl = renderer.context;
		///gl.activeTexture(gl.TEXTURE_2D, terrainTexture.id);
		///gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, document.getElementById('terrainCanvas'));

		//terrainTexture.needsUpdate = true;

		let tile = terrainTiles.getRenderTile();
		if (!!tile)
		{
			terrainTexture.update( tile.image, tile.drawX, tile.drawY );
		}
	}

	mapTiles.render(longtitude, latitude);
	{
		//smallMapCanvas.getContext('2d').drawImage(mapCanvas, 0, 0, smallMapCanvas.width, smallMapCanvas.height);
		//let offset = new THREE.Vector2(mapTiles.getNormalizedOffsetX(), mapTiles.getNormalizedOffsetY());

		material.uniforms.mapTextureOffset.value.x = mapTiles.getNormalizedOffsetX();
		material.uniforms.mapTextureOffset.value.y = mapTiles.getNormalizedOffsetY();
		material.uniforms.mapTextureOffset.value.needsUpdate = true;

		//mapTexture.needsUpdate = true;

		let tile = mapTiles.getRenderTile();
		if (!!tile)
		{
			mapTexture.update( tile.image, tile.drawX, tile.drawY );
		}



	}


	
	const m = geometry.parameters.width / (canvasComplexity / tileDimension); // mesh size / n tiles
	mesh.position.x = ((-1 * (user.x % 1) + 0.5)) * m;
	mesh.position.z = ((-1 * (user.z % 1) + 0.5)) * m;
	mesh.position.y = user.y * -1;

/*
	disable moving to do some performance tests
	if (true == moving) {
		if (window.performance.now() - downTime > 1000) {
			// wait 1000ms before moving forward
			// this gives the user time to turn the camera
			let vector = new THREE.Vector3(0, 0, -0.001);
			vector.applyQuaternion(orbitControls.object.quaternion);
			user.add(vector);
		}
	}
*/
	controls.update();	// update HMD head position

	// Shouldn't fly to high or too low...
	//if (user.y < 0.1) user.y = 0.1;
	//if (user.y > 2) user.y = 2;


	effect.render(scene, camera);


}

// Resize the WebGL canvas when the window size changes
function onWindowResize() {
	camera.aspect = window.innerWidth / window.innerHeight;
	camera.updateProjectionMatrix();
	renderer.setSize(window.innerWidth, window.innerHeight);
}

let geocoder;
function geocodeAddress() {
	geocoder = new google.maps.Geocoder()

	let address = document.getElementById('address').value;
	geocoder.geocode({ 'address': address }, function (results, status) {
		if (status === 'OK') {

			user.x = long2tile(results[0].geometry.location.lng(), mapZoom);
			user.z = lat2tile(results[0].geometry.location.lat() - 0.152, mapZoom); // south... to put object in view

			renderer.domElement.focus();

		} else {
			// Geocode was not successful for reason = status
		}
	});
}


// Main initialization
function init() {

	initGraphics();

	document.onkeydown = checkKey;

	document.getElementById('address').onkeydown = function (e) {
		e.stopPropagation();
	};

	renderer.domElement.onclick = function(e){e.srcElement.focus()};

	document.getElementById('geoControls').addEventListener('submit', function (e) {
		geocodeAddress();
		e.preventDefault();
	});

	renderScene();	// Start main rendering loop
}