---
title: 在世界中渲染
description: 当原版管线不能满足需求时，创建并使用自定义渲染管线。
authors:
  - AzureAaron
  - kevinthegreat1
---

<!---->

:::info 前置条件

确保你已阅读过[渲染概念](./basic-concepts)。 本页基于这些概念并讨论如何渲染世界上的对象。

本页探讨了一些更现代的渲染概念。 你将进一步了解渲染的两个阶段：“提取”（或称“准备”）与“绘制”（或称“渲染”）。 在本指南中，我们将“提取/准备”阶段称为“提取”阶段，将“绘制/渲染”阶段称为“绘制”阶段。

:::

要在世界中渲染自定义对象，你有两种选择。 你可以注入现有的原版渲染并添加代码，但这会限制你只能使用现有的原版渲染管线。 如果现有的原版渲染管线无法满足你的需求，则需要自定义渲染管线。

在讨论自定义渲染管线之前，我们先来了解一下原版渲染。

## 提取和绘制阶段 {#the-extraction-and-drawing-phases}

正如[渲染概念](./basic-concepts)中所提到的，Minecraft 的最新更新致力于将渲染分为两个阶段：“提取”和“绘制”。

渲染所需的所有数据都在“提取”阶段收集。 这包括访问世界数据等。 请注意，许多方法即使以 `draw` 或 `render` 为前缀，也应该在“提取”阶段调用。 你应该在此阶段添加所有要渲染的元素。

“提取”阶段完成后，“绘制”阶段开始，并构建缓冲构建器。 在这个阶段，缓冲构建器被绘制到屏幕上。 这种“提取”和“绘制”分离的最终目标是允许并行绘制上一帧和提取下一帧，从而提高性能。

现在，考虑到这两个阶段，让我们看看如何创建自定义渲染管线。

## 自定义渲染管线 {#custom-render-pipelines}

假设我们要渲染需要穿过墙壁显示的路径点。 最接近该效果的原版渲染管线是 `RenderPipelines#DEBUG_FILLED_BOX`，但它无法穿过墙壁进行渲染，因此我们需要一个自定义渲染管线。

### 定义自定义渲染管线 {#defining-a-custom-render-pipeline}

我们在一个类中定义自定义渲染管线：


```java
	private static final RenderPipeline FILLED_THROUGH_WALLS = RenderPipelines.register(RenderPipeline.builder(RenderPipelines.DEBUG_FILLED_SNIPPET)
			.withLocation(Identifier.fromNamespaceAndPath(ExampleMod.MOD_ID, "pipeline/debug_filled_box_through_walls"))
			.withDepthStencilState(Optional.empty())
			.build()
	);
```

### 提取阶段 {#extraction-phase}

我们首先实现“提取”阶段。 我们可以在“提取”阶段调用这个方法来添加要渲染的路径点。


```java
	private static WaypointRenderState waypointState;

	private void extractWaypoint(LevelExtractionContext context) {
		// Access data from the world or anything here in the extraction phase.
		// You can only access the (immutable and thread safe) render state in the drawing phase.
		waypointState = new WaypointRenderState(0, 100, 0, 0f, 1f, 0f, 0.5f);
	}

	// Render states should be immutable, thread safe, and fast to create.
	private record WaypointRenderState(int x, int y, int z, float r, float g, float b, float a) { }
```

如果要渲染多个路径点，请将 `waypointState` 更改为列表并添加多个路径点渲染状态。 确保在“提取”阶段（即“绘制”阶段开始之前，缓冲区构建器在此时构建）执行此操作。

### 渲染状态 {#render-states}

请注意，在上面的代码中，我们将 `WaypointRenderState` 保存在一个字段中。 这是因为我们在“绘制”阶段需要它。 在这种情况下，`WaypointRenderState` 就是我们的“渲染状态”或“提取的数据”。 如果在“绘制”阶段需要额外数据（即来自世界的数据），则应将其添加到自定义渲染状态类中。

### 绘制阶段 {#drawing-phase}

现在我们将实现“绘制”阶段。 在“提取”阶段，所有需要渲染的路径点都添加到 `waypointState` 后，应该调用这个阶段。


```java
	private static final ByteBufferBuilder ALLOCATOR = new ByteBufferBuilder(RenderType.SMALL_BUFFER_SIZE);
	private static final Vector4f COLOR_MODULATOR = new Vector4f(1f, 1f, 1f, 1f);
	private static final Vector3f MODEL_OFFSET = new Vector3f();
	private static final Matrix4f TEXTURE_MATRIX = new Matrix4f();
	private BufferBuilder buffer;
	private MappableRingBuffer vertexBuffer;

	private void renderAndDrawWaypoint(LevelRenderContext context) {
		this.renderWaypoint(context);
		this.drawFilledThroughWalls(Minecraft.getInstance(), FILLED_THROUGH_WALLS);
	}

	private void renderWaypoint(LevelRenderContext context) {
		PoseStack matrices = context.poseStack();
		Vec3 camera = context.levelState().cameraRenderState.pos;

		matrices.pushPose();
		matrices.translate(-camera.x, -camera.y, -camera.z);

		if (this.buffer == null) {
			this.buffer = new BufferBuilder(ALLOCATOR, FILLED_THROUGH_WALLS.getVertexFormatMode(), FILLED_THROUGH_WALLS.getVertexFormat());
		}

		this.renderFilledBox(matrices.last().pose(), this.buffer, waypointState.x(), waypointState.y(), waypointState.z(), waypointState.x() + 1, waypointState.y() + 1, waypointState.z() + 1, waypointState.r(), waypointState.g(), waypointState.b(), waypointState.a());

		matrices.popPose();
	}

	private void renderFilledBox(Matrix4fc positionMatrix, BufferBuilder buffer, float minX, float minY, float minZ, float maxX, float maxY, float maxZ, float red, float green, float blue, float alpha) {
		// Front Face
		buffer.addVertex(positionMatrix, minX, minY, maxZ).setColor(red, green, blue, alpha);
		buffer.addVertex(positionMatrix, maxX, minY, maxZ).setColor(red, green, blue, alpha);
		buffer.addVertex(positionMatrix, maxX, maxY, maxZ).setColor(red, green, blue, alpha);
		buffer.addVertex(positionMatrix, minX, maxY, maxZ).setColor(red, green, blue, alpha);

		// Back face
		buffer.addVertex(positionMatrix, maxX, minY, minZ).setColor(red, green, blue, alpha);
		buffer.addVertex(positionMatrix, minX, minY, minZ).setColor(red, green, blue, alpha);
		buffer.addVertex(positionMatrix, minX, maxY, minZ).setColor(red, green, blue, alpha);
		buffer.addVertex(positionMatrix, maxX, maxY, minZ).setColor(red, green, blue, alpha);

		// Left face
		buffer.addVertex(positionMatrix, minX, minY, minZ).setColor(red, green, blue, alpha);
		buffer.addVertex(positionMatrix, minX, minY, maxZ).setColor(red, green, blue, alpha);
		buffer.addVertex(positionMatrix, minX, maxY, maxZ).setColor(red, green, blue, alpha);
		buffer.addVertex(positionMatrix, minX, maxY, minZ).setColor(red, green, blue, alpha);

		// Right face
		buffer.addVertex(positionMatrix, maxX, minY, maxZ).setColor(red, green, blue, alpha);
		buffer.addVertex(positionMatrix, maxX, minY, minZ).setColor(red, green, blue, alpha);
		buffer.addVertex(positionMatrix, maxX, maxY, minZ).setColor(red, green, blue, alpha);
		buffer.addVertex(positionMatrix, maxX, maxY, maxZ).setColor(red, green, blue, alpha);

		// Top face
		buffer.addVertex(positionMatrix, minX, maxY, maxZ).setColor(red, green, blue, alpha);
		buffer.addVertex(positionMatrix, maxX, maxY, maxZ).setColor(red, green, blue, alpha);
		buffer.addVertex(positionMatrix, maxX, maxY, minZ).setColor(red, green, blue, alpha);
		buffer.addVertex(positionMatrix, minX, maxY, minZ).setColor(red, green, blue, alpha);

		// Bottom face
		buffer.addVertex(positionMatrix, minX, minY, minZ).setColor(red, green, blue, alpha);
		buffer.addVertex(positionMatrix, maxX, minY, minZ).setColor(red, green, blue, alpha);
		buffer.addVertex(positionMatrix, maxX, minY, maxZ).setColor(red, green, blue, alpha);
		buffer.addVertex(positionMatrix, minX, minY, maxZ).setColor(red, green, blue, alpha);
	}

	private void drawFilledThroughWalls(Minecraft client, @SuppressWarnings("SameParameterValue") RenderPipeline pipeline) {
		// Build the buffer
		MeshData builtBuffer = this.buffer.buildOrThrow();
		MeshData.DrawState drawParameters = builtBuffer.drawState();
		VertexFormat format = drawParameters.format();

		GpuBuffer vertices = this.upload(drawParameters, format, builtBuffer);

		draw(client, pipeline, builtBuffer, drawParameters, vertices, format);

		// Rotate the vertex buffer so we are less likely to use buffers that the GPU is using
		this.vertexBuffer.rotate();
		this.buffer = null;
	}

	private GpuBuffer upload(MeshData.DrawState drawParameters, VertexFormat format, MeshData builtBuffer) {
		// Calculate the size needed for the vertex buffer
		int vertexBufferSize = drawParameters.vertexCount() * format.getVertexSize();

		// Initialize or resize the vertex buffer as needed
		if (this.vertexBuffer == null || this.vertexBuffer.size() < vertexBufferSize) {
			if (this.vertexBuffer != null) {
				this.vertexBuffer.close();
			}

			this.vertexBuffer = new MappableRingBuffer(() -> ExampleMod.MOD_ID + " example render pipeline", GpuBuffer.USAGE_VERTEX | GpuBuffer.USAGE_MAP_WRITE, vertexBufferSize);
		}

		// Copy vertex data into the vertex buffer
		CommandEncoder commandEncoder = RenderSystem.getDevice().createCommandEncoder();

		try (GpuBuffer.MappedView mappedView = commandEncoder.mapBuffer(this.vertexBuffer.currentBuffer().slice(0, builtBuffer.vertexBuffer().remaining()), false, true)) {
			MemoryUtil.memCopy(builtBuffer.vertexBuffer(), mappedView.data());
		}

		return this.vertexBuffer.currentBuffer();
	}

	private static void draw(Minecraft client, RenderPipeline pipeline, MeshData builtBuffer, MeshData.DrawState drawParameters, GpuBuffer vertices, VertexFormat format) {
		GpuBuffer indices;
		VertexFormat.IndexType indexType;

		if (pipeline.getVertexFormatMode() == VertexFormat.Mode.QUADS) {
			// Sort the quads if there is translucency
			builtBuffer.sortQuads(ALLOCATOR, RenderSystem.getProjectionType().vertexSorting());
			// Upload the index buffer
			indices = pipeline.getVertexFormat().uploadImmediateIndexBuffer(builtBuffer.indexBuffer());
			indexType = builtBuffer.drawState().indexType();
		} else {
			// Use the general shape index buffer for non-quad draw modes
			RenderSystem.AutoStorageIndexBuffer shapeIndexBuffer = RenderSystem.getSequentialBuffer(pipeline.getVertexFormatMode());
			indices = shapeIndexBuffer.getBuffer(drawParameters.indexCount());
			indexType = shapeIndexBuffer.type();
		}

		// Actually execute the draw
		GpuBufferSlice dynamicTransforms = RenderSystem.getDynamicUniforms()
				.writeTransform(RenderSystem.getModelViewMatrix(), COLOR_MODULATOR, MODEL_OFFSET, TEXTURE_MATRIX);
		try (RenderPass renderPass = RenderSystem.getDevice()
				.createCommandEncoder()
				.createRenderPass(() -> ExampleMod.MOD_ID + " example render pipeline rendering", client.getMainRenderTarget().getColorTextureView(), OptionalInt.empty(), client.getMainRenderTarget().getDepthTextureView(), OptionalDouble.empty())) {
			renderPass.setPipeline(pipeline);

			RenderSystem.bindDefaultUniforms(renderPass);
			renderPass.setUniform("DynamicTransforms", dynamicTransforms);

			// Bind texture if applicable:
			// Sampler0 is used for texture inputs in vertices
			// renderPass.bindTexture("Sampler0", textureSetup.texure0(), textureSetup.sampler0());

			renderPass.setVertexBuffer(0, vertices);
			renderPass.setIndexBuffer(indices, indexType);

			// The base vertex is the starting index when we copied the data into the vertex buffer divided by vertex size
			//noinspection ConstantValue
			renderPass.drawIndexed(0 / format.getVertexSize(), 0, drawParameters.indexCount(), 1);
		}

		builtBuffer.close();
	}
```

请注意，`ByteBufferBuilder` 构造函数中使用的大小取决于你使用的渲染管线。 在我们的例子中，它是 `RenderType.SMALL_BUFFER_SIZE`。

### 清理 {#cleaning-up}

最后，我们需要在游戏渲染器关闭时清理资源。 `GameRenderer#close` 应该调用这个方法，为此，你目前需要将 mixin 注入到 `GameRenderer#close` 中。


```java
	public void close() {
		ALLOCATOR.close();

		if (this.vertexBuffer != null) {
			this.vertexBuffer.close();
			this.vertexBuffer = null;
		}
	}
```


```java
package com.example.docs.mixin.client;

import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

import net.minecraft.client.renderer.GameRenderer;

import com.example.docs.rendering.CustomRenderPipeline;

@Mixin(GameRenderer.class)
public class GameRendererMixin {
	@Inject(method = "close", at = @At("RETURN"))
	private void onGameRendererClose(CallbackInfo ci) {
		CustomRenderPipeline.getInstance().close();
	}
}
```

### 最终代码 {#final-code}

结合以上所有步骤，我们得到了一个简单的类，渲染一个穿过墙壁的路径点，位于 `(0, 100, 0)`。


```java
package com.example.docs.rendering;

import java.util.Optional;
import java.util.OptionalDouble;
import java.util.OptionalInt;

import com.mojang.blaze3d.buffers.GpuBuffer;
import com.mojang.blaze3d.buffers.GpuBufferSlice;
import com.mojang.blaze3d.pipeline.RenderPipeline;
import com.mojang.blaze3d.systems.CommandEncoder;
import com.mojang.blaze3d.systems.RenderPass;
import com.mojang.blaze3d.systems.RenderSystem;
import com.mojang.blaze3d.vertex.BufferBuilder;
import com.mojang.blaze3d.vertex.ByteBufferBuilder;
import com.mojang.blaze3d.vertex.MeshData;
import com.mojang.blaze3d.vertex.PoseStack;
import com.mojang.blaze3d.vertex.VertexFormat;
import org.joml.Matrix4f;
import org.joml.Matrix4fc;
import org.joml.Vector3f;
import org.joml.Vector4f;
import org.lwjgl.system.MemoryUtil;

import net.minecraft.client.Minecraft;
import net.minecraft.client.renderer.MappableRingBuffer;
import net.minecraft.client.renderer.RenderPipelines;
import net.minecraft.client.renderer.rendertype.RenderType;
import net.minecraft.resources.Identifier;
import net.minecraft.world.phys.Vec3;

import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.rendering.v1.level.LevelExtractionContext;
import net.fabricmc.fabric.api.client.rendering.v1.level.LevelRenderContext;
import net.fabricmc.fabric.api.client.rendering.v1.level.LevelRenderEvents;

import com.example.docs.ExampleMod;

public class CustomRenderPipeline implements ClientModInitializer {
	private static CustomRenderPipeline instance;
	// #region custom_pipelines_define_pipeline
	private static final RenderPipeline FILLED_THROUGH_WALLS = RenderPipelines.register(RenderPipeline.builder(RenderPipelines.DEBUG_FILLED_SNIPPET)
			.withLocation(Identifier.fromNamespaceAndPath(ExampleMod.MOD_ID, "pipeline/debug_filled_box_through_walls"))
			.withDepthStencilState(Optional.empty())
			.build()
	);
	// #endregion custom_pipelines_define_pipeline
	// #region custom_pipelines_extraction_phase
	private static WaypointRenderState waypointState;

	// #endregion custom_pipelines_extraction_phase
	// #region custom_pipelines_drawing_phase
	private static final ByteBufferBuilder ALLOCATOR = new ByteBufferBuilder(RenderType.SMALL_BUFFER_SIZE);
	private static final Vector4f COLOR_MODULATOR = new Vector4f(1f, 1f, 1f, 1f);
	private static final Vector3f MODEL_OFFSET = new Vector3f();
	private static final Matrix4f TEXTURE_MATRIX = new Matrix4f();
	private BufferBuilder buffer;
	private MappableRingBuffer vertexBuffer;

	// #endregion custom_pipelines_drawing_phase
	public static CustomRenderPipeline getInstance() {
		return instance;
	}

	@Override
	public void onInitializeClient() {
		instance = this;
		LevelRenderEvents.END_EXTRACTION.register(this::extractWaypoint);
		LevelRenderEvents.AFTER_TRANSLUCENT_TERRAIN.register(this::renderAndDrawWaypoint);
	}

	// #region custom_pipelines_extraction_phase
	private void extractWaypoint(LevelExtractionContext context) {
		// Access data from the world or anything here in the extraction phase.
		// You can only access the (immutable and thread safe) render state in the drawing phase.
		waypointState = new WaypointRenderState(0, 100, 0, 0f, 1f, 0f, 0.5f);
	}

	// #endregion custom_pipelines_extraction_phase
	// #region custom_pipelines_drawing_phase
	private void renderAndDrawWaypoint(LevelRenderContext context) {
		this.renderWaypoint(context);
		this.drawFilledThroughWalls(Minecraft.getInstance(), FILLED_THROUGH_WALLS);
	}

	private void renderWaypoint(LevelRenderContext context) {
		PoseStack matrices = context.poseStack();
		Vec3 camera = context.levelState().cameraRenderState.pos;

		matrices.pushPose();
		matrices.translate(-camera.x, -camera.y, -camera.z);

		if (this.buffer == null) {
			this.buffer = new BufferBuilder(ALLOCATOR, FILLED_THROUGH_WALLS.getVertexFormatMode(), FILLED_THROUGH_WALLS.getVertexFormat());
		}

		this.renderFilledBox(matrices.last().pose(), this.buffer, waypointState.x(), waypointState.y(), waypointState.z(), waypointState.x() + 1, waypointState.y() + 1, waypointState.z() + 1, waypointState.r(), waypointState.g(), waypointState.b(), waypointState.a());

		matrices.popPose();
	}

	private void renderFilledBox(Matrix4fc positionMatrix, BufferBuilder buffer, float minX, float minY, float minZ, float maxX, float maxY, float maxZ, float red, float green, float blue, float alpha) {
		// Front Face
		buffer.addVertex(positionMatrix, minX, minY, maxZ).setColor(red, green, blue, alpha);
		buffer.addVertex(positionMatrix, maxX, minY, maxZ).setColor(red, green, blue, alpha);
		buffer.addVertex(positionMatrix, maxX, maxY, maxZ).setColor(red, green, blue, alpha);
		buffer.addVertex(positionMatrix, minX, maxY, maxZ).setColor(red, green, blue, alpha);

		// Back face
		buffer.addVertex(positionMatrix, maxX, minY, minZ).setColor(red, green, blue, alpha);
		buffer.addVertex(positionMatrix, minX, minY, minZ).setColor(red, green, blue, alpha);
		buffer.addVertex(positionMatrix, minX, maxY, minZ).setColor(red, green, blue, alpha);
		buffer.addVertex(positionMatrix, maxX, maxY, minZ).setColor(red, green, blue, alpha);

		// Left face
		buffer.addVertex(positionMatrix, minX, minY, minZ).setColor(red, green, blue, alpha);
		buffer.addVertex(positionMatrix, minX, minY, maxZ).setColor(red, green, blue, alpha);
		buffer.addVertex(positionMatrix, minX, maxY, maxZ).setColor(red, green, blue, alpha);
		buffer.addVertex(positionMatrix, minX, maxY, minZ).setColor(red, green, blue, alpha);

		// Right face
		buffer.addVertex(positionMatrix, maxX, minY, maxZ).setColor(red, green, blue, alpha);
		buffer.addVertex(positionMatrix, maxX, minY, minZ).setColor(red, green, blue, alpha);
		buffer.addVertex(positionMatrix, maxX, maxY, minZ).setColor(red, green, blue, alpha);
		buffer.addVertex(positionMatrix, maxX, maxY, maxZ).setColor(red, green, blue, alpha);

		// Top face
		buffer.addVertex(positionMatrix, minX, maxY, maxZ).setColor(red, green, blue, alpha);
		buffer.addVertex(positionMatrix, maxX, maxY, maxZ).setColor(red, green, blue, alpha);
		buffer.addVertex(positionMatrix, maxX, maxY, minZ).setColor(red, green, blue, alpha);
		buffer.addVertex(positionMatrix, minX, maxY, minZ).setColor(red, green, blue, alpha);

		// Bottom face
		buffer.addVertex(positionMatrix, minX, minY, minZ).setColor(red, green, blue, alpha);
		buffer.addVertex(positionMatrix, maxX, minY, minZ).setColor(red, green, blue, alpha);
		buffer.addVertex(positionMatrix, maxX, minY, maxZ).setColor(red, green, blue, alpha);
		buffer.addVertex(positionMatrix, minX, minY, maxZ).setColor(red, green, blue, alpha);
	}

	private void drawFilledThroughWalls(Minecraft client, @SuppressWarnings("SameParameterValue") RenderPipeline pipeline) {
		// Build the buffer
		MeshData builtBuffer = this.buffer.buildOrThrow();
		MeshData.DrawState drawParameters = builtBuffer.drawState();
		VertexFormat format = drawParameters.format();

		GpuBuffer vertices = this.upload(drawParameters, format, builtBuffer);

		draw(client, pipeline, builtBuffer, drawParameters, vertices, format);

		// Rotate the vertex buffer so we are less likely to use buffers that the GPU is using
		this.vertexBuffer.rotate();
		this.buffer = null;
	}

	private GpuBuffer upload(MeshData.DrawState drawParameters, VertexFormat format, MeshData builtBuffer) {
		// Calculate the size needed for the vertex buffer
		int vertexBufferSize = drawParameters.vertexCount() * format.getVertexSize();

		// Initialize or resize the vertex buffer as needed
		if (this.vertexBuffer == null || this.vertexBuffer.size() < vertexBufferSize) {
			if (this.vertexBuffer != null) {
				this.vertexBuffer.close();
			}

			this.vertexBuffer = new MappableRingBuffer(() -> ExampleMod.MOD_ID + " example render pipeline", GpuBuffer.USAGE_VERTEX | GpuBuffer.USAGE_MAP_WRITE, vertexBufferSize);
		}

		// Copy vertex data into the vertex buffer
		CommandEncoder commandEncoder = RenderSystem.getDevice().createCommandEncoder();

		try (GpuBuffer.MappedView mappedView = commandEncoder.mapBuffer(this.vertexBuffer.currentBuffer().slice(0, builtBuffer.vertexBuffer().remaining()), false, true)) {
			MemoryUtil.memCopy(builtBuffer.vertexBuffer(), mappedView.data());
		}

		return this.vertexBuffer.currentBuffer();
	}

	private static void draw(Minecraft client, RenderPipeline pipeline, MeshData builtBuffer, MeshData.DrawState drawParameters, GpuBuffer vertices, VertexFormat format) {
		GpuBuffer indices;
		VertexFormat.IndexType indexType;

		if (pipeline.getVertexFormatMode() == VertexFormat.Mode.QUADS) {
			// Sort the quads if there is translucency
			builtBuffer.sortQuads(ALLOCATOR, RenderSystem.getProjectionType().vertexSorting());
			// Upload the index buffer
			indices = pipeline.getVertexFormat().uploadImmediateIndexBuffer(builtBuffer.indexBuffer());
			indexType = builtBuffer.drawState().indexType();
		} else {
			// Use the general shape index buffer for non-quad draw modes
			RenderSystem.AutoStorageIndexBuffer shapeIndexBuffer = RenderSystem.getSequentialBuffer(pipeline.getVertexFormatMode());
			indices = shapeIndexBuffer.getBuffer(drawParameters.indexCount());
			indexType = shapeIndexBuffer.type();
		}

		// Actually execute the draw
		GpuBufferSlice dynamicTransforms = RenderSystem.getDynamicUniforms()
				.writeTransform(RenderSystem.getModelViewMatrix(), COLOR_MODULATOR, MODEL_OFFSET, TEXTURE_MATRIX);
		try (RenderPass renderPass = RenderSystem.getDevice()
				.createCommandEncoder()
				.createRenderPass(() -> ExampleMod.MOD_ID + " example render pipeline rendering", client.getMainRenderTarget().getColorTextureView(), OptionalInt.empty(), client.getMainRenderTarget().getDepthTextureView(), OptionalDouble.empty())) {
			renderPass.setPipeline(pipeline);

			RenderSystem.bindDefaultUniforms(renderPass);
			renderPass.setUniform("DynamicTransforms", dynamicTransforms);

			// Bind texture if applicable:
			// Sampler0 is used for texture inputs in vertices
			// renderPass.bindTexture("Sampler0", textureSetup.texure0(), textureSetup.sampler0());

			renderPass.setVertexBuffer(0, vertices);
			renderPass.setIndexBuffer(indices, indexType);

			// The base vertex is the starting index when we copied the data into the vertex buffer divided by vertex size
			//noinspection ConstantValue
			renderPass.drawIndexed(0 / format.getVertexSize(), 0, drawParameters.indexCount(), 1);
		}

		builtBuffer.close();
	}
	// #endregion custom_pipelines_drawing_phase

	// #region custom_pipelines_clean_up
	public void close() {
		ALLOCATOR.close();

		if (this.vertexBuffer != null) {
			this.vertexBuffer.close();
			this.vertexBuffer = null;
		}
	}
	// #endregion custom_pipelines_clean_up

	// #region custom_pipelines_extraction_phase
	// Render states should be immutable, thread safe, and fast to create.
	private record WaypointRenderState(int x, int y, int z, float r, float g, float b, float a) { }
	// #endregion custom_pipelines_extraction_phase
}
```

别忘了 `GameRendererMixin`！ 结果如下：

![穿过墙壁的路径点渲染](/assets/develop/rendering/world-rendering-custom-render-pipeline-waypoint.png)
