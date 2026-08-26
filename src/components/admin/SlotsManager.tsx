import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Calendar } from "@/components/ui/calendar";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { Plus, Trash2, CalendarIcon, Clock, ExternalLink, RotateCcw, FileText, RefreshCw, History } from "lucide-react";
import { format, startOfMonth, endOfMonth, subMonths } from "date-fns";
import { ru } from "date-fns/locale";

interface Slot {
  id: string;
  date: string;
  time: string;
  status: "free" | "booked";
  client_id: string | null;
  comment: string | null;
  format: "online" | "offline" | null;
  available_formats: "offline" | "online" | "both";
  clients?: {
    first_name: string | null;
    last_name: string | null;
    username: string | null;
    telegram_id: number;
  } | null;
}

interface TemplateDay {
  day: string;
  times: Array<{ time: string; available_formats: string }>;
}

const weekDaysNames: Record<string, string> = {
  monday: "Понедельник",
  tuesday: "Вторник",
  wednesday: "Среда",
  thursday: "Четверг",
  friday: "Пятница",
  saturday: "Суббота",
  sunday: "Воскресенье",
};

function mapApiSlots(data: any[]): Slot[] {
  return data.map((slot: any) => ({
    ...slot,
    clients: slot.first_name || slot.last_name || slot.username ? {
      first_name: slot.first_name,
      last_name: slot.last_name,
      username: slot.username,
      telegram_id: slot.telegram_id,
    } : null,
  })) as Slot[];
}

function groupSlotsByDate(slots: Slot[]) {
  return slots.reduce((acc, slot) => {
    if (!acc[slot.date]) acc[slot.date] = [];
    acc[slot.date].push(slot);
    return acc;
  }, {} as Record<string, Slot[]>);
}

const previousMonthDate = subMonths(new Date(), 1);
const previousMonthFrom = format(startOfMonth(previousMonthDate), "yyyy-MM-dd");
const previousMonthTo = format(endOfMonth(previousMonthDate), "yyyy-MM-dd");
const previousMonthLabel = format(previousMonthDate, "LLLL yyyy", { locale: ru });

const SlotsManager = () => {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [selectedDate, setSelectedDate] = useState<Date | undefined>(new Date());
  const [newSlotTime, setNewSlotTime] = useState("10:00");
  const [newSlotFormats, setNewSlotFormats] = useState<"offline" | "online" | "both">("both");
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [weeksToApply, setWeeksToApply] = useState("1");
  const [scheduleTab, setScheduleTab] = useState("current");

  const { data: slots = [], isLoading } = useQuery({
    queryKey: ["slots"],
    queryFn: async () => mapApiSlots(await api.getSlots()),
  });

  const { data: pastMonthSlots = [], isLoading: isLoadingPastMonth } = useQuery({
    queryKey: ["slots", "previous-month", previousMonthFrom, previousMonthTo],
    queryFn: async () => mapApiSlots(
      await api.getSlots({ from: previousMonthFrom, to: previousMonthTo })
    ),
    enabled: scheduleTab === "previous",
  });

  const { data: template, isLoading: isLoadingTemplate } = useQuery({
    queryKey: ["schedule_template"],
    queryFn: async () => {
      return await api.getScheduleTemplate();
    },
  });

  const createSlotMutation = useMutation({
    mutationFn: async ({ date, time, available_formats }: { date: string; time: string; available_formats: string }) => {
      await api.createSlot({ date, time, available_formats });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["slots"] });
      toast({ title: "Слот создан" });
    },
    onError: (error) => {
      toast({ title: "Ошибка", description: error.message, variant: "destructive" });
    },
  });

  const deleteSlotMutation = useMutation({
    mutationFn: async (slotId: string) => {
      await api.deleteSlot(slotId);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["slots"] });
      toast({ title: "Слот удалён" });
    },
    onError: (error) => {
      toast({ title: "Ошибка", description: error.message, variant: "destructive" });
    },
  });

  const cancelBookingMutation = useMutation({
    mutationFn: async (slotId: string) => {
      return await api.cancelBooking(slotId);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["slots"] });
      toast({ title: "Запись отменена", description: "Клиент получил уведомление" });
    },
    onError: (error) => {
      toast({ title: "Ошибка", description: error.message, variant: "destructive" });
    },
  });

  const saveTemplateMutation = useMutation({
    mutationFn: async () => {
      return await api.saveScheduleTemplate();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["schedule_template"] });
      toast({ title: "Шаблон сохранён", description: "Текущая неделя сохранена как шаблон" });
    },
    onError: (error) => {
      toast({ title: "Ошибка", description: error.message, variant: "destructive" });
    },
  });

  const deleteTemplateMutation = useMutation({
    mutationFn: async () => {
      return await api.deleteScheduleTemplate();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["schedule_template"] });
      toast({ title: "Шаблон удалён" });
    },
    onError: (error) => {
      toast({ title: "Ошибка", description: error.message, variant: "destructive" });
    },
  });

  const applyTemplateMutation = useMutation({
    mutationFn: async (weeks: number) => {
      return await api.applyScheduleTemplate(weeks);
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["slots"] });
      toast({ title: "Шаблон применён", description: `Создано слотов: ${data.created}` });
    },
    onError: (error) => {
      toast({ title: "Ошибка", description: error.message, variant: "destructive" });
    },
  });

  const handleCreateSlot = () => {
    if (!selectedDate) return;
    const dateStr = format(selectedDate, "yyyy-MM-dd");
    createSlotMutation.mutate({ date: dateStr, time: newSlotTime, available_formats: newSlotFormats });
  };

  const handleApplyTemplate = () => {
    const weeks = parseInt(weeksToApply);
    if (weeks < 1) {
      toast({ title: "Ошибка", description: "Количество недель должно быть не менее 1", variant: "destructive" });
      return;
    }
    applyTemplateMutation.mutate(weeks);
  };

  const timeOptions = [];
  for (let h = 7; h <= 22; h++) {
    timeOptions.push(`${h.toString().padStart(2, "0")}:00`);
    if (h < 22) timeOptions.push(`${h.toString().padStart(2, "0")}:30`);
  }

  // Group slots by date
  const slotsByDate = groupSlotsByDate(slots);
  const pastBookings = pastMonthSlots.filter((slot) => slot.status === "booked");
  const pastBookingsByDate = groupSlotsByDate(pastBookings);

  const renderSlotRow = (slot: Slot, readOnly = false) => {
    const fullName = [slot.clients?.first_name, slot.clients?.last_name]
      .filter(Boolean)
      .join(" ") || slot.clients?.username || "Клиент";
    const formatLabel = slot.format === "online" ? "💻" : "🏠";

    return (
      <div
        key={slot.id}
        className="flex items-center justify-between p-3 rounded-lg border border-border bg-card hover:bg-accent/50 transition-colors"
      >
        <div className="flex items-center gap-3">
          <span className="font-medium">{slot.time.slice(0, 5)}</span>
          {slot.status === "booked" ? (
            <>
              <div className="flex items-center gap-2 flex-wrap">
                <Badge variant="secondary" className="flex items-center gap-1">
                  {formatLabel} {fullName}
                </Badge>
                {slot.comment === 'Регулярный клиент' && (
                  <Badge variant="outline" className="text-xs bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950 dark:text-blue-300 dark:border-blue-800">
                    Регулярный
                  </Badge>
                )}
              </div>
              {slot.clients?.telegram_id && (
                <a
                  href={`https://t.me/${slot.clients.username || ''}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:text-primary/80 transition-colors"
                  title="Открыть чат в Telegram"
                >
                  <ExternalLink className="h-4 w-4" />
                </a>
              )}
            </>
          ) : (
            <>
              <Badge variant="outline" className="text-success border-success">
                Свободно
              </Badge>
              <span className="text-xs text-muted-foreground">
                {slot.available_formats === "both" ? "🏠💻" : slot.available_formats === "offline" ? "🏠" : "💻"}
              </span>
            </>
          )}
        </div>
        {!readOnly && (
          <div className="flex items-center gap-2">
            {slot.status === "booked" && (
              <Button
                variant="ghost"
                size="icon"
                onClick={() => cancelBookingMutation.mutate(slot.id)}
                disabled={cancelBookingMutation.isPending}
                title="Отменить запись"
              >
                <Trash2 className="h-4 w-4 text-destructive" />
              </Button>
            )}
            {slot.status === "free" && (
              <Button
                variant="ghost"
                size="icon"
                onClick={() => deleteSlotMutation.mutate(slot.id)}
                disabled={deleteSlotMutation.isPending}
                title="Удалить слот"
              >
                <Trash2 className="h-4 w-4 text-destructive" />
              </Button>
            )}
          </div>
        )}
      </div>
    );
  };

  const renderScheduleByDate = (
    slotsGrouped: Record<string, Slot[]>,
    readOnly = false,
    emptyMessage: string
  ) => {
    if (Object.keys(slotsGrouped).length === 0) {
      return <p className="text-muted-foreground">{emptyMessage}</p>;
    }

    return (
      <div className="space-y-6">
        {Object.entries(slotsGrouped).map(([date, daySlots]) => (
          <div key={date}>
            <h3 className="font-medium text-foreground mb-3">
              {format(new Date(date), "EEEE, d MMMM", { locale: ru })}
            </h3>
            <div className="space-y-2">
              {daySlots.map((slot) => renderSlotRow(slot, readOnly))}
            </div>
          </div>
        ))}
      </div>
    );
  };

  return (
    <div className="space-y-6">
      {/* Top Row: Add Slot and Regular Schedule */}
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Add Slot */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Plus className="h-5 w-5" />
              Добавить слот
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label>Дата</Label>
              <Popover open={calendarOpen} onOpenChange={setCalendarOpen}>
                <PopoverTrigger asChild>
                  <Button variant="outline" className="w-full justify-start text-left font-normal mt-1">
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    {selectedDate ? format(selectedDate, "PPP", { locale: ru }) : "Выберите дату"}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start" side="bottom" collisionPadding={8}>
                  <Calendar
                    mode="single"
                    selected={selectedDate}
                    onSelect={(date) => {
                      setSelectedDate(date);
                      setCalendarOpen(false);
                    }}
                    locale={ru}
                    disabled={(date) => date < new Date()}
                  />
                </PopoverContent>
              </Popover>
            </div>

            <div>
              <Label>Время</Label>
              <Select value={newSlotTime} onValueChange={setNewSlotTime}>
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {timeOptions.map((time) => (
                    <SelectItem key={time} value={time}>
                      {time}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label>Формат консультации</Label>
              <Select value={newSlotFormats} onValueChange={(v) => setNewSlotFormats(v as "offline" | "online" | "both")}>
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="both">🏠💻 Очно и онлайн</SelectItem>
                  <SelectItem value="offline">🏠 Только очно</SelectItem>
                  <SelectItem value="online">💻 Только онлайн</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <Button
              onClick={handleCreateSlot}
              className="w-full"
              disabled={!selectedDate || createSlotMutation.isPending}
            >
              <Plus className="mr-2 h-4 w-4" />
              Создать слот
            </Button>
          </CardContent>
        </Card>

        {/* Regular Schedule */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <RotateCcw className="h-5 w-5" />
              Регулярное расписание
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Сохраните текущую неделю как шаблон и применяйте его на следующие недели.
            </p>

            <Button
              onClick={() => saveTemplateMutation.mutate()}
              variant="outline"
              className="w-full"
              disabled={saveTemplateMutation.isPending}
            >
              <FileText className="mr-2 h-4 w-4" />
              Сохранить текущую неделю как шаблон
            </Button>

            {isLoadingTemplate ? (
              <p className="text-sm text-muted-foreground">Загрузка шаблона...</p>
            ) : template && template.days && template.days.length > 0 ? (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label className="text-sm font-semibold">Сохранённый шаблон:</Label>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => deleteTemplateMutation.mutate()}
                    disabled={deleteTemplateMutation.isPending}
                    className="h-8 text-destructive hover:text-destructive"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
                <div className="space-y-1">
                  {(() => {
                    // Sort days by week order (Monday to Sunday)
                    const weekOrder = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
                    const sortedDays = [...template.days].sort((a, b) => {
                      return weekOrder.indexOf(a.day) - weekOrder.indexOf(b.day);
                    });
                    return sortedDays.map((day: TemplateDay) => (
                      <div key={day.day} className="text-sm">
                        <span className="font-medium">{weekDaysNames[day.day]}:</span>{" "}
                        {day.times.map(t => t.time).join(", ")}
                      </div>
                    ));
                  })()}
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">Нет сохранённого шаблона</p>
            )}

            <div>
              <Label>Количество недель для применения</Label>
              <Select value={weeksToApply} onValueChange={setWeeksToApply}>
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[1, 2, 3, 4, 5, 6, 7, 8].map((w) => (
                    <SelectItem key={w} value={w.toString()}>
                      {w} {w === 1 ? "неделя" : w < 5 ? "недели" : "недель"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <Button
              onClick={handleApplyTemplate}
              className="w-full"
              disabled={applyTemplateMutation.isPending || !template || !template.days || template.days.length === 0}
            >
              <RefreshCw className="mr-2 h-4 w-4" />
              Применить шаблон
            </Button>
          </CardContent>
        </Card>
      </div>

      {/* Schedule List - Full Width */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Clock className="h-5 w-5" />
            Расписание
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Tabs value={scheduleTab} onValueChange={setScheduleTab}>
            <TabsList className="mb-4">
              <TabsTrigger value="current" className="gap-2">
                <Clock className="h-4 w-4" />
                Текущее
              </TabsTrigger>
              <TabsTrigger value="previous" className="gap-2">
                <History className="h-4 w-4" />
                {previousMonthLabel}
              </TabsTrigger>
            </TabsList>

            <TabsContent value="current">
              {isLoading ? (
                <p className="text-muted-foreground">Загрузка...</p>
              ) : (
                renderScheduleByDate(slotsByDate, false, "Нет слотов")
              )}
            </TabsContent>

            <TabsContent value="previous">
              {isLoadingPastMonth ? (
                <p className="text-muted-foreground">Загрузка...</p>
              ) : (
                <>
                  <p className="text-sm text-muted-foreground mb-4">
                    Записи за {previousMonthLabel}: {pastBookings.length}
                  </p>
                  {renderScheduleByDate(
                    pastBookingsByDate,
                    true,
                    `За ${previousMonthLabel} записей нет`
                  )}
                </>
              )}
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
};

export default SlotsManager;
