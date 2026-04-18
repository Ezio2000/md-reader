# ECharts Example

这个示例文件用来验证 ECharts 插件是否正常工作。

下面是一个柱状图示例：

```echarts
{
  "title": {
    "text": "Markdown Asset Overview",
    "left": 12,
    "top": 10,
    "textStyle": {
      "fontSize": 18,
      "fontWeight": 600
    }
  },
  "legend": {
    "top": 46,
    "left": 12,
    "itemGap": 18
  },
  "grid": {
    "top": 108,
    "left": 52,
    "right": 24,
    "bottom": 40,
    "containLabel": true
  },
  "tooltip": {
    "trigger": "axis",
    "axisPointer": {
      "type": "shadow"
    }
  },
  "xAxis": {
    "type": "category",
    "data": ["demo", "dist", "plugins", "docs"],
    "axisTick": {
      "show": false
    },
    "axisLabel": {
      "margin": 12
    }
  },
  "yAxis": {
    "type": "value",
    "splitLine": {
      "lineStyle": {
        "color": "#e6ddd3"
      }
    }
  },
  "series": [
    {
      "name": "Public Pages",
      "type": "bar",
      "data": [2, 3, 4, 6],
      "barWidth": 22,
      "barGap": "30%",
      "itemStyle": {
        "color": "#9b5d2f",
        "borderRadius": [6, 6, 0, 0]
      }
    },
    {
      "name": "Plugin Assets",
      "type": "bar",
      "data": [1, 2, 5, 3],
      "barWidth": 22,
      "itemStyle": {
        "color": "#d1a173",
        "borderRadius": [6, 6, 0, 0]
      }
    }
  ]
}
```

你也可以用带 `option` 包裹的形式，并额外指定高度和渲染器：

```echarts
({
  height: 460,
  renderer: "svg",
  option: {
    title: {
      text: "Plugin Activity Trend",
      left: 12,
      top: 10,
      textStyle: {
        fontSize: 18,
        fontWeight: 600
      }
    },
    legend: {
      top: 46,
      left: 12,
      itemGap: 18
    },
    grid: {
      top: 112,
      left: 52,
      right: 28,
      bottom: 42,
      containLabel: true
    },
    tooltip: {
      trigger: "axis",
      axisPointer: {
        type: "line"
      }
    },
    xAxis: {
      type: "category",
      boundaryGap: false,
      data: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
      axisLabel: {
        margin: 12
      }
    },
    yAxis: {
      type: "value",
      splitLine: {
        lineStyle: {
          color: "#e6ddd3"
        }
      }
    },
    series: [
      {
        name: "Mermaid",
        type: "line",
        smooth: true,
        symbolSize: 8,
        data: [12, 18, 16, 24, 28, 22, 30],
        lineStyle: {
          color: "#7e4318",
          width: 3
        },
        areaStyle: {
          color: "rgba(155, 93, 47, 0.18)"
        }
      },
      {
        name: "ECharts",
        type: "line",
        smooth: true,
        symbolSize: 8,
        data: [8, 10, 14, 18, 21, 25, 29],
        lineStyle: {
          color: "#b98553",
          width: 3
        },
        areaStyle: {
          color: "rgba(185, 133, 83, 0.14)"
        }
      }
    ]
  }
})
```
