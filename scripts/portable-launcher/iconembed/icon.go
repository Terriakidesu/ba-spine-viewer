package main

import (
	"encoding/binary"
	"fmt"
)

var iconSizes = [...]int{16, 24, 32, 48, 64, 128, 256}

type iconPoint struct {
	x float64
	y float64
}

// The Editor and Viewer launchers share the mark in apps/{editor,viewer}/public/favicon.svg.
var brandMark = [...]iconPoint{
	{18, 13}, {46, 13}, {46, 21}, {27, 21}, {27, 29}, {43, 29},
	{43, 37}, {27, 37}, {27, 51}, {18, 51},
}

func makeIconDIB(size int) []byte {
	const samples = 8
	rowBytes := size * 4
	xorBytes := rowBytes * size
	maskStride := ((size + 31) / 32) * 4
	maskBytes := maskStride * size
	image := make([]byte, 40+xorBytes+maskBytes)

	binary.LittleEndian.PutUint32(image[0:4], 40)
	binary.LittleEndian.PutUint32(image[4:8], uint32(size))
	binary.LittleEndian.PutUint32(image[8:12], uint32(size*2))
	binary.LittleEndian.PutUint16(image[12:14], 1)
	binary.LittleEndian.PutUint16(image[14:16], 32)
	binary.LittleEndian.PutUint32(image[20:24], uint32(xorBytes+maskBytes))

	for y := 0; y < size; y++ {
		for x := 0; x < size; x++ {
			var red, green, blue, covered int
			for sy := 0; sy < samples; sy++ {
				for sx := 0; sx < samples; sx++ {
					point := iconPoint{
						x: (float64(x) + (float64(sx)+0.5)/samples) * 64 / float64(size),
						y: (float64(y) + (float64(sy)+0.5)/samples) * 64 / float64(size),
					}
					color, inside := brandColorAt(point)
					if !inside {
						continue
					}
					red += int(color[0])
					green += int(color[1])
					blue += int(color[2])
					covered++
				}
			}

			if covered == 0 {
				continue
			}
			alpha := covered * 255 / (samples * samples)
			row := size - 1 - y
			pixelOffset := 40 + row*rowBytes + x*4
			image[pixelOffset+0] = byte(blue / covered)
			image[pixelOffset+1] = byte(green / covered)
			image[pixelOffset+2] = byte(red / covered)
			image[pixelOffset+3] = byte(alpha)
			if alpha < 128 {
				maskOffset := 40 + xorBytes + row*maskStride + x/8
				image[maskOffset] |= 0x80 >> uint(x%8)
			}
		}
	}
	return image
}

func brandColorAt(point iconPoint) ([3]byte, bool) {
	if !insideRoundedSquare(point) {
		return [3]byte{}, false
	}
	color := [3]byte{0x10, 0x21, 0x31}
	if insidePolygon(point, brandMark[:]) {
		color = [3]byte{0x5b, 0xdc, 0xff}
	}
	if dx, dy := point.x-46, point.y-47; dx*dx+dy*dy <= 36 {
		color = [3]byte{0xff, 0x76, 0x9d}
	}
	return color, true
}

func insideRoundedSquare(point iconPoint) bool {
	const radius = 12.0
	dx, dy := 0.0, 0.0
	if point.x < radius {
		dx = radius - point.x
	} else if point.x > 64-radius {
		dx = point.x - (64 - radius)
	}
	if point.y < radius {
		dy = radius - point.y
	} else if point.y > 64-radius {
		dy = point.y - (64 - radius)
	}
	return dx*dx+dy*dy <= radius*radius
}

func insidePolygon(point iconPoint, polygon []iconPoint) bool {
	inside := false
	for i, j := 0, len(polygon)-1; i < len(polygon); j, i = i, i+1 {
		first, second := polygon[i], polygon[j]
		if (first.y > point.y) != (second.y > point.y) && point.x < (second.x-first.x)*(point.y-first.y)/(second.y-first.y)+first.x {
			inside = !inside
		}
	}
	return inside
}

func iconGroupResource(images [][]byte) ([]byte, error) {
	if len(images) == 0 || len(images) > 0xffff {
		return nil, fmt.Errorf("icon resource must contain between 1 and 65535 images")
	}
	group := make([]byte, 6+14*len(images))
	binary.LittleEndian.PutUint16(group[2:4], 1)
	binary.LittleEndian.PutUint16(group[4:6], uint16(len(images)))
	for index, image := range images {
		if len(image) < 40 || uint64(len(image)) > uint64(^uint32(0)) {
			return nil, fmt.Errorf("icon image %d has an invalid size", index)
		}
		dibWidth := int32(binary.LittleEndian.Uint32(image[4:8]))
		if dibWidth < 1 || dibWidth > 256 {
			return nil, fmt.Errorf("icon image %d has an invalid width", index)
		}
		entry := group[6+index*14 : 6+(index+1)*14]
		if dibWidth < 256 {
			entry[0] = byte(dibWidth)
			entry[1] = byte(dibWidth)
		}
		binary.LittleEndian.PutUint16(entry[4:6], 1)
		binary.LittleEndian.PutUint16(entry[6:8], 32)
		binary.LittleEndian.PutUint32(entry[8:12], uint32(len(image)))
		binary.LittleEndian.PutUint16(entry[12:14], uint16(index+1))
	}
	return group, nil
}
